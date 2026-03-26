import { isQuantKilled } from "./risk-manager.js";
// VL-04: GARCH-chan killed (negative P&L, unprofitable on live)
// import { runGarchChanCycle } from "./garch-chan-engine.js";
// Replaced by Donchian+Supertrend ensemble
// import { runBtcMrCycle } from "./btc-mr-engine.js";
// VL-04: BTC-Event killed (insufficient edge, paper never promoted)
// import { runBtcEventCycle } from "./btc-event-engine.js";
// VL-04: News-Trade killed (high variance, net negative)
// import { runNewsTradingCycle } from "./news-trading-engine.js";
import { runDonchianTrendCycle } from "./donchian-trend-engine.js";
import { runSupertrend4hCycle } from "./supertrend-4h-engine.js";

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

    // VL-04: runGarchChanCycle removed (negative P&L)
    // VL-04: runBtcEventCycle removed (insufficient edge)
    // VL-04: runNewsTradingCycle removed (net negative)

    // Replaced by ensemble
    // try { await runBtcMrCycle(); }
    // catch (err) { console.error(`[QuantScheduler] BTC-MR error: ${err instanceof Error ? err.message : String(err)}`); }

    try { await runDonchianTrendCycle(); }
    catch (err) { console.error(`[QuantScheduler] DonchianTrend error: ${err instanceof Error ? err.message : String(err)}`); }

    try { await runSupertrend4hCycle(); }
    catch (err) { console.error(`[QuantScheduler] Supertrend4h error: ${err instanceof Error ? err.message : String(err)}`); }

    console.log(`[QuantScheduler] Cycle: DonchianTrend + Supertrend4h running`);
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
