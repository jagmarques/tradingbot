// Market regime system: Fear & Greed + BTC 7d momentum → 4 regimes
// RISK-OFF: Fear<25 + BTC declining → shorts only, GARCH on
// RECOVERY: Fear<25 + BTC rising → both directions, GARCH off (sentiment lags price)
// RISK-ON: Fear>=25 + BTC rising → normal, both directions
// CORRECTION: Fear>=25 + BTC declining → both but half size

let cachedValue: number | null = null;
let cachedAt = 0;
const CACHE_TTL = 4 * 60 * 60 * 1000;

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
    return cachedValue;
  }
}

// Bounce protection
let bouncePauseUntil = 0;

export function updateBtcBounceCheck(currentBtcPrice: number, btc3dLow: number): void {
  if (btc3dLow > 0 && currentBtcPrice > btc3dLow * 1.05 && Date.now() > bouncePauseUntil) {
    bouncePauseUntil = Date.now() + 24 * 60 * 60 * 1000;
    console.log(`[Regime] BOUNCE: BTC +${((currentBtcPrice / btc3dLow - 1) * 100).toFixed(1)}% from 3d low -> pausing shorts 24h`);
  }
}

export function isBouncePauseActive(): boolean {
  return Date.now() < bouncePauseUntil;
}

// 4-state macro regime
export type MacroRegime = "risk-off" | "recovery" | "risk-on" | "correction";

const FEAR_THRESHOLD = 25;
const BTC_7D_DECLINE = -0.03;

let currentRegime: MacroRegime = "risk-on";

export function updateMacroRegime(btc7dReturn: number): void {
  const fg = cachedValue ?? 50;
  const prev = currentRegime;
  const fearful = fg < FEAR_THRESHOLD;
  const declining = btc7dReturn < BTC_7D_DECLINE;

  if (fearful && declining) currentRegime = "risk-off";
  else if (fearful && !declining) currentRegime = "recovery";
  else if (!fearful && declining) currentRegime = "correction";
  else currentRegime = "risk-on";

  if (currentRegime !== prev) {
    console.log(`[Regime] ${prev} -> ${currentRegime} (Fear=${fg}, BTC 7d=${(btc7dReturn * 100).toFixed(1)}%)`);
  }
}

export function getMacroRegime(): MacroRegime { return currentRegime; }

export function isRiskOff(): boolean { return currentRegime === "risk-off"; }

// Direction bias per regime
export async function getRegimeBias(): Promise<"long" | "short" | "both"> {
  if (isBouncePauseActive()) return "long";
  const fg = await getFearGreedIndex();
  if (fg === null) return "both";

  if (currentRegime === "risk-off") return "short";
  if (currentRegime === "recovery") return "both"; // KEY FIX: allow longs in recovery
  if (fg >= 80) return "long";
  return "both";
}

// Position size multiplier per regime
export function getRegimeSizeMultiplier(): number {
  switch (currentRegime) {
    case "risk-off": return 1.0;
    case "recovery": return 0.75;
    case "risk-on": return 1.0;
    case "correction": return 0.5;
  }
}
