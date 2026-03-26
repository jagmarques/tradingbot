import { isQuantKilled } from "./risk-manager.js";
import { updateBtcBounceCheck, updateBearRegime, isBearRegime } from "../market-regime/fear-greed.js";
import { getEventSizeMultiplier } from "../market-regime/event-calendar.js";
import { fetchCandles } from "./candles.js";
import { runDonchianTrendCycle } from "./donchian-trend-engine.js";
import { runSupertrend4hCycle } from "./supertrend-4h-engine.js";
import { runGarchV2Cycle } from "./garch-v2-engine.js"; // Auto-activated in bear regimes
import { runCarryMomentumCycle } from "./carry-momentum-engine.js";
import { isBtcBullish } from "./indicators.js";

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

    // Bear regime detection (daily bars for proper EMA 20/50 = 20 day / 50 day)
    try {
      const btcDaily = await fetchCandles("BTC", "1d", 60);
      if (btcDaily.length >= 52) {
        const completed = btcDaily.slice(0, -1);
        const ema20Below50 = !isBtcBullish(completed, 20, 50);
        const btcNow = completed[completed.length - 1].close;
        const btc30dAgo = completed[Math.max(0, completed.length - 30)].close;
        const btc30dReturn = (btcNow - btc30dAgo) / btc30dAgo;
        updateBearRegime(ema20Below50, btc30dReturn);
      }
    } catch { /* non-critical */ }

    try { await runDonchianTrendCycle(); }
    catch (err) { console.error(`[QuantScheduler] DonchianTrend error: ${err instanceof Error ? err.message : String(err)}`); }

    try { await runSupertrend4hCycle(); }
    catch (err) { console.error(`[QuantScheduler] Supertrend4h error: ${err instanceof Error ? err.message : String(err)}`); }

    // GARCH v2: disabled - auto-bear gate too strict (37/1180 days, PF 0.55 when active)
    // Waiting for improved regime system (Fear zones + momentum) before re-enabling
    // if (isBearRegime()) {
    //   try { await runGarchV2Cycle(); }
    //   catch (err) { console.error(`[QuantScheduler] GarchV2 error: ${err}`); }
    // }

    try { await runCarryMomentumCycle(); }
    catch (err) { console.error(`[QuantScheduler] CarryMomentum error: ${err instanceof Error ? err.message : String(err)}`); }

    const eventMult = getEventSizeMultiplier();
    if (eventMult < 1) console.log(`[QuantScheduler] Event risk: size x${eventMult}`);

    const engineCount = isBearRegime() ? 4 : 3;
    console.log(`[QuantScheduler] Cycle: ${engineCount} engines (${isBearRegime() ? "+GARCH bear mode" : "normal"})`);
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
