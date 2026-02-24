import { runAIDecisionEngine } from "./ai-analyzer.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { isQuantKilled } from "./risk-manager.js";
import { QUANT_SCHEDULER_INTERVAL_MS } from "../../config/constants.js";

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

    const decisions = await runAIDecisionEngine();
    let executed = 0;

    // Block pair if ANY directional position is open (prevents contradictory long+short)
    const openPairs = new Set(
      getOpenQuantPositions()
        .filter(p => p.tradeType === "directional" || !p.tradeType)
        .map(p => p.pair),
    );

    for (const decision of decisions) {
      if (decision.suggestedSizeUsd <= 0 || decision.direction === "flat") {
        continue;
      }

      if (openPairs.has(decision.pair)) {
        console.log(`[QuantScheduler] Skipping ${decision.pair} ${decision.direction}: pair already open`);
        continue;
      }

      const position = await openPosition(
        decision.pair,
        decision.direction,
        decision.suggestedSizeUsd,
        3,
        decision.stopLoss,
        decision.takeProfit,
        decision.regime,
        decision.confidence,
        decision.reasoning,
        "directional",
        undefined,
        decision.entryPrice,
      );

      if (position) {
        executed++;
        openPairs.add(decision.pair);
        console.log(
          `[QuantScheduler] Opened ${decision.pair} ${decision.direction} $${decision.suggestedSizeUsd.toFixed(2)} @ ${decision.entryPrice}`,
        );
      }
    }

    console.log(`[QuantScheduler] Cycle complete: ${executed}/${decisions.length} positions opened`);
  } finally {
    cycleRunning = false;
  }
}

export function startQuantScheduler(): void {
  if (schedulerInterval !== null || initialRunTimeout !== null) {
    return;
  }

  console.log("[QuantScheduler] Started (3m interval, 3x leverage)");

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
