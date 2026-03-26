import { isQuantKilled } from "./risk-manager.js";
import { updateBtcBounceCheck } from "../market-regime/fear-greed.js";
import { getEventSizeMultiplier } from "../market-regime/event-calendar.js";
import { fetchCandles } from "./candles.js";
import { runDonchianTrendCycle } from "./donchian-trend-engine.js";
import { runSupertrend4hCycle } from "./supertrend-4h-engine.js";
import { runGarchV2Cycle } from "./garch-v2-engine.js";
import { runCarryMomentumCycle } from "./carry-momentum-engine.js";
import { runRangeExpansionCycle } from "./range-expansion-engine.js";

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

    // Bounce protection: check BTC 3-day low vs current price
    try {
      const btcCandles = await fetchCandles("BTC", "4h", 20);
      if (btcCandles.length >= 18) {
        const last18 = btcCandles.slice(-18); // ~3 days of 4h bars
        const btc3dLow = Math.min(...last18.map(c => c.low));
        const btcNow = btcCandles[btcCandles.length - 1].close;
        updateBtcBounceCheck(btcNow, btc3dLow);
      }
    } catch { /* non-critical */ }

    try { await runDonchianTrendCycle(); }
    catch (err) { console.error(`[QuantScheduler] DonchianTrend error: ${err instanceof Error ? err.message : String(err)}`); }

    try { await runSupertrend4hCycle(); }
    catch (err) { console.error(`[QuantScheduler] Supertrend4h error: ${err instanceof Error ? err.message : String(err)}`); }

    try { await runGarchV2Cycle(); }
    catch (err) { console.error(`[QuantScheduler] GarchV2 error: ${err instanceof Error ? err.message : String(err)}`); }

    try { await runCarryMomentumCycle(); }
    catch (err) { console.error(`[QuantScheduler] CarryMomentum error: ${err instanceof Error ? err.message : String(err)}`); }

    try { await runRangeExpansionCycle(); }
    catch (err) { console.error(`[QuantScheduler] RangeExpansion error: ${err instanceof Error ? err.message : String(err)}`); }

    // Log event calendar status (doesn't block, just informs)
    const eventMult = getEventSizeMultiplier();
    if (eventMult < 1) console.log(`[QuantScheduler] Event risk active: size multiplier = ${eventMult}`);

    console.log(`[QuantScheduler] Cycle: 5 engines running`);
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
