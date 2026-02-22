import { runAIDecisionEngine } from "./ai-analyzer.js";
import { openPosition } from "./executor.js";
import { isQuantKilled } from "./risk-manager.js";
import { QUANT_SCHEDULER_INTERVAL_MS } from "../../config/constants.js";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;

export async function runDirectionalCycle(): Promise<void> {
  console.log("[QuantScheduler] Directional trading disabled, skipping cycle");
  return;

  if (isQuantKilled()) {
    console.log("[QuantScheduler] Kill switch active, skipping cycle");
    return;
  }

  const decisions = await runAIDecisionEngine();
  let executed = 0;

  for (const decision of decisions) {
    if (decision.suggestedSizeUsd <= 0) {
      continue;
    }

    if (decision.direction === "flat") {
      continue;
    }

    const position = await openPosition(
      decision.pair,
      decision.direction as "long" | "short",
      decision.suggestedSizeUsd,
      1, // leverage: no leverage in paper mode
      decision.stopLoss,
      decision.takeProfit,
      decision.regime,
      decision.confidence,
      decision.reasoning,
      "directional",
      undefined, // indicatorsAtEntry: AI reasoning captures context; raw indicators not in QuantAIDecision
    );

    if (position) {
      executed++;
      console.log(
        `[QuantScheduler] Opened ${decision.direction} ${decision.pair} $${decision.suggestedSizeUsd.toFixed(2)} (confidence=${decision.confidence}%)`,
      );
    }
  }

  console.log(
    `[QuantScheduler] Cycle complete: ${decisions.length} decisions, ${executed} executed`,
  );
}

export function startQuantScheduler(): void {
  if (schedulerInterval !== null || initialRunTimeout !== null) {
    return;
  }

  console.log("[QuantScheduler] Started (15m interval)");

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
