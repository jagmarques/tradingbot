
// Groq K2 pricing (free tier, track for monitoring)
const INPUT_COST_PER_M = 0.0;
const OUTPUT_COST_PER_M = 0.0;

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

  if (daily.byCaller[caller].calls > 500) {
    console.warn(`[CostMonitor] High usage: ${caller} ${daily.byCaller[caller].calls} calls today`);
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
