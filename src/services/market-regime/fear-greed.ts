// Fear & Greed Index - free API from Alternative.me
// Used as global regime gate: Extreme Fear -> shorts only, Extreme Greed -> longs only
// Backtested: +35% Sharpe, -29% MaxDD when trend-aligned

let cachedValue: number | null = null;
let cachedAt = 0;
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4h cache (updates daily anyway)

export async function getFearGreedIndex(): Promise<number | null> {
  if (cachedValue !== null && Date.now() - cachedAt < CACHE_TTL) return cachedValue;
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return cachedValue;
    const data = (await res.json()) as { data?: Array<{ value: string; value_classification: string }> };
    const value = parseInt(data?.data?.[0]?.value ?? "");
    if (!isNaN(value)) {
      cachedValue = value;
      cachedAt = Date.now();
      console.log(`[FearGreed] Index: ${value} (${data?.data?.[0]?.value_classification})`);
    }
    return cachedValue;
  } catch {
    return cachedValue; // Return stale cache on error
  }
}

// Bounce protection: if BTC rips >5% from 3-day low, pause new shorts for 24h
// Prevents getting caught in a snap reversal when all positions are short
let bouncePauseUntil = 0;

export function updateBtcBounceCheck(currentBtcPrice: number, btc3dLow: number): void {
  if (btc3dLow > 0 && currentBtcPrice > btc3dLow * 1.05 && Date.now() > bouncePauseUntil) {
    bouncePauseUntil = Date.now() + 24 * 60 * 60 * 1000;
    console.log(`[FearGreed] BOUNCE DETECTED: BTC ${currentBtcPrice.toFixed(0)} is +${((currentBtcPrice / btc3dLow - 1) * 100).toFixed(1)}% from 3d low ${btc3dLow.toFixed(0)} -> pausing new shorts for 24h`);
  }
}

export function isBouncePauseActive(): boolean {
  return Date.now() < bouncePauseUntil;
}

// Bear regime detection for auto-activating GARCH v2
// GARCH v2 makes +$9.26/mo in bear but bleeds in sideways
// Auto-enable when: BTC EMA(20) < EMA(50) AND Fear < 25 AND BTC 30d return < -10%
let bearRegimeActive = false;

export function updateBearRegime(btcEma20BelowEma50: boolean, btc30dReturn: number): void {
  const fg = cachedValue ?? 50;
  const wasBear = bearRegimeActive;
  bearRegimeActive = btcEma20BelowEma50 && fg <= 25 && btc30dReturn < -0.10;
  if (bearRegimeActive && !wasBear) {
    console.log(`[Regime] BEAR detected: EMA bearish, Fear=${fg}, BTC 30d=${(btc30dReturn * 100).toFixed(1)}% -> activating GARCH v2`);
  } else if (!bearRegimeActive && wasBear) {
    console.log(`[Regime] Bear regime ended -> deactivating GARCH v2`);
  }
}

export function isBearRegime(): boolean {
  return bearRegimeActive;
}

// Returns which directions are allowed based on Fear & Greed + bounce protection
export async function getRegimeBias(): Promise<"long" | "short" | "both"> {
  // Bounce protection overrides Fear/Greed: block shorts during BTC snap reversal
  if (isBouncePauseActive()) return "long";

  const fg = await getFearGreedIndex();
  if (fg === null) return "both";
  if (fg <= 20) return "short"; // Extreme Fear: only shorts (trend-aligned)
  if (fg >= 80) return "long"; // Extreme Greed: only longs (trend-aligned)
  return "both";
}
