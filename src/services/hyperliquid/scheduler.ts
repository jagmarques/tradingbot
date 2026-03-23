import { isQuantKilled } from "./risk-manager.js";
import { runGarchChanCycle } from "./garch-chan-engine.js";
import { runBtcMrCycle } from "./btc-mr-engine.js";
import { runBtcEventCycle } from "./btc-event-engine.js";
import { runNewsTradingCycle } from "./news-trading-engine.js";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;
let cycleRunning = false;

const CYCLE_MS = 15 * 60 * 1000;
const SL_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const slCooldowns = new Map<string, number>();

export function recordStopLossCooldown(pair: string, direction: string, tradeType = "directional"): void {
  slCooldowns.set(`${pair}:${direction}:${tradeType}`, Date.now());
}

export function isInStopLossCooldown(pair: string, direction: string, tradeType = "directional"): boolean {
  const ts = slCooldowns.get(`${pair}:${direction}:${tradeType}`);
  if (!ts) return false;
  if (Date.now() - ts > SL_COOLDOWN_MS) { slCooldowns.delete(`${pair}:${direction}:${tradeType}`); return false; }
  return true;
}

export async function runDirectionalCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    if (isQuantKilled()) return;

    try { await runGarchChanCycle(); }
    catch (err) { console.error(`[QuantScheduler] GARCH-v2 error: ${err instanceof Error ? err.message : String(err)}`); }

    try { await runBtcMrCycle(); }
    catch (err) { console.error(`[QuantScheduler] BTC-MR error: ${err instanceof Error ? err.message : String(err)}`); }

    try { await runBtcEventCycle(); }
    catch (err) { console.error(`[QuantScheduler] BTC-Event error: ${err instanceof Error ? err.message : String(err)}`); }

    try { await runNewsTradingCycle(); }
    catch (err) { console.error(`[QuantScheduler] News-Trade error: ${err instanceof Error ? err.message : String(err)}`); }

    console.log(`[QuantScheduler] Cycle: GARCH-v2 + BTC-MR + BTC-Event + News-Trade running`);
  } finally { cycleRunning = false; }
}

export function startQuantScheduler(): void {
  if (schedulerInterval !== null || initialRunTimeout !== null) return;
  console.log("[QuantScheduler] Started (15m interval)");
  initialRunTimeout = setTimeout(() => { void runDirectionalCycle(); }, 15_000);
  schedulerInterval = setInterval(() => { void runDirectionalCycle(); }, CYCLE_MS);
}

export function stopQuantScheduler(): void {
  if (schedulerInterval !== null) { clearInterval(schedulerInterval); schedulerInterval = null; }
  if (initialRunTimeout !== null) { clearTimeout(initialRunTimeout); initialRunTimeout = null; }
  console.log("[QuantScheduler] Stopped");
}
