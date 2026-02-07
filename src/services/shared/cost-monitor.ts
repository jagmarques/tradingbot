import { loadEnv } from "../../config/env.js";

// DeepSeek pricing ($/M tokens) - as of 2026-02
const INPUT_COST_PER_M = 0.14;
const OUTPUT_COST_PER_M = 2.19;

interface CallerStats {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costUsd: number;
}

interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costUsd: number;
  byCaller: Record<string, CallerStats>;
}

function todayDateString(): string {
  return new Date().toISOString().split("T")[0];
}

let daily: DailyUsage = {
  date: todayDateString(),
  inputTokens: 0,
  outputTokens: 0,
  calls: 0,
  costUsd: 0,
  byCaller: {},
};

function ensureCurrentDay(): void {
  const today = todayDateString();
  if (daily.date !== today) {
    daily = {
      date: today,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      costUsd: 0,
      byCaller: {},
    };
  }
}

export function trackUsage(inputTokens: number, outputTokens: number, caller: string): void {
  ensureCurrentDay();

  const cost = (inputTokens * INPUT_COST_PER_M + outputTokens * OUTPUT_COST_PER_M) / 1_000_000;

  daily.inputTokens += inputTokens;
  daily.outputTokens += outputTokens;
  daily.calls += 1;
  daily.costUsd += cost;

  if (!daily.byCaller[caller]) {
    daily.byCaller[caller] = { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 };
  }
  daily.byCaller[caller].inputTokens += inputTokens;
  daily.byCaller[caller].outputTokens += outputTokens;
  daily.byCaller[caller].calls += 1;
  daily.byCaller[caller].costUsd += cost;

  // Budget alerts
  const env = loadEnv();
  const budget = env.DEEPSEEK_DAILY_BUDGET;
  const pct = (daily.costUsd / budget) * 100;

  if (daily.costUsd > budget) {
    console.warn(
      `[CostMonitor] ALERT: Daily DeepSeek spend $${daily.costUsd.toFixed(4)} exceeded budget $${budget.toFixed(2)}`
    );
  } else if (pct >= 80) {
    console.warn(
      `[CostMonitor] WARNING: Daily DeepSeek spend $${daily.costUsd.toFixed(4)} approaching budget $${budget.toFixed(2)} (${pct.toFixed(0)}%)`
    );
  }
}

export function getDailyCost(): number {
  ensureCurrentDay();
  return daily.costUsd;
}

export function getCostStats(): {
  date: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costUsd: number;
  estimatedMonthlyCost: number;
  byCaller: Record<string, CallerStats>;
} {
  ensureCurrentDay();
  return {
    date: daily.date,
    inputTokens: daily.inputTokens,
    outputTokens: daily.outputTokens,
    calls: daily.calls,
    costUsd: daily.costUsd,
    estimatedMonthlyCost: daily.costUsd * 30,
    byCaller: { ...daily.byCaller },
  };
}

export function resetDailyCost(): void {
  daily = {
    date: todayDateString(),
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    costUsd: 0,
    byCaller: {},
  };
}
