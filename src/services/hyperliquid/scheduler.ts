import { isQuantKilled } from "./risk-manager.js";
import { updateBtcBounceCheck, updateMacroRegime, getMacroRegime } from "../market-regime/fear-greed.js";
import { fetchCandles } from "./candles.js";
import { runGarchV2Cycle } from "./garch-v2-engine.js";
import { QUANT_SCHEDULER_INTERVAL_MS } from "../../config/constants.js";

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let initialRunTimeout: ReturnType<typeof setTimeout> | null = null;
let cycleRunning = false;

const CYCLE_MS = QUANT_SCHEDULER_INTERVAL_MS;
const SL_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h cooldown (matches bt-1m-mega cd4h)
const H1_ENTRY_WINDOW_MIN = 5; // allow entries only in first 5 min of each hour (matches bt 1h boundary)
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

// Gate entries to first H1_ENTRY_WINDOW_MIN minutes of each hour, mirroring backtest's 1h-boundary entries.
// Prevents systematic intra-hour drift where live enters 3-30 min after signal, filling at worse prices.
export function isInH1EntryWindow(): boolean {
  return new Date().getUTCMinutes() < H1_ENTRY_WINDOW_MIN;
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

    // GARCH v2 lb1/vw30 long-only (verified: $2.40/day MDD $32 mc7)
    try { await runGarchV2Cycle(); }
    catch (err) { console.error(`[QuantScheduler] GarchV2 error: ${err instanceof Error ? err.message : String(err)}`); }

    const regime = getMacroRegime();
    console.log(`[QuantScheduler] Cycle: 1 engine | regime=${regime}`);
  } finally { cycleRunning = false; }
}

export function startQuantScheduler(): void {
  if (schedulerInterval !== null || initialRunTimeout !== null) return;
  console.log(`[QuantScheduler] Started (${CYCLE_MS / 60000}m interval)`);
  initialRunTimeout = setTimeout(() => { void runDirectionalCycle(); }, 15_000);
  schedulerInterval = setInterval(() => { void runDirectionalCycle(); }, CYCLE_MS);
}

export function stopQuantScheduler(): void {
  if (schedulerInterval !== null) { clearInterval(schedulerInterval); schedulerInterval = null; }
  if (initialRunTimeout !== null) { clearTimeout(initialRunTimeout); initialRunTimeout = null; }
  console.log("[QuantScheduler] Stopped");
}
