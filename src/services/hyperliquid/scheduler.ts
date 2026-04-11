import { isQuantKilled } from "./risk-manager.js";
import { updateBtcBounceCheck, updateMacroRegime, getMacroRegime } from "../market-regime/fear-greed.js";
import { getEventSizeMultiplier } from "../market-regime/event-calendar.js";
import { fetchCandles } from "./candles.js";
import { runGarchV2Cycle } from "./garch-v2-engine.js";
import { runRangeExpansionCycle } from "./range-expansion-engine.js";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;
let cycleRunning = false;

const CYCLE_MS = 15 * 60 * 1000;
const SL_COOLDOWN_MS = 1 * 60 * 60 * 1000; // 1h cooldown (backtest: PF 2.07 vs 2.03 at 2h)
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

    // Bounce protection (4h bars for 3-day low)
    try {
      const btc4h = await fetchCandles("BTC", "4h", 20);
      if (btc4h.length >= 18) {
        const last18 = btc4h.slice(-18);
        const btc3dLow = Math.min(...last18.map(c => c.low));
        const btcNow = btc4h[btc4h.length - 1].close;
        updateBtcBounceCheck(btcNow, btc3dLow);
      }
    } catch { /* non-critical */ }

    // Macro regime: Fear & Greed + BTC 7d momentum → 4 states
    try {
      const btcDaily = await fetchCandles("BTC", "1d", 15);
      if (btcDaily.length >= 9) {
        const completed = btcDaily.slice(0, -1);
        const btcNow = completed[completed.length - 1].close;
        const btc7dAgo = completed[Math.max(0, completed.length - 7)].close;
        const btc7dReturn = (btcNow - btc7dAgo) / btc7dAgo;
        updateMacroRegime(btc7dReturn);
      }
    } catch { /* non-critical */ }

    // Engine 1: GARCH long-only loose (OOS $1.17/day MDD $17)
    try { await runGarchV2Cycle(); }
    catch (err) { console.error(`[QuantScheduler] GarchV2 error: ${err instanceof Error ? err.message : String(err)}`); }

    // Engine 2: Range Expansion (OOS $1.24/day MDD $12, correlation 0.09 with GARCH = true diversifier)
    try { await runRangeExpansionCycle(); }
    catch (err) { console.error(`[QuantScheduler] RangeExpansion error: ${err instanceof Error ? err.message : String(err)}`); }

    const regime = getMacroRegime();

    const eventMult = getEventSizeMultiplier();
    if (eventMult < 1) console.log(`[QuantScheduler] Event risk: size x${eventMult}`);

    console.log(`[QuantScheduler] Cycle: 2 engines | regime=${regime}`);
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
