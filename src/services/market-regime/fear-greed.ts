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

// Returns which directions are allowed based on Fear & Greed
export async function getRegimeBias(): Promise<"long" | "short" | "both"> {
  const fg = await getFearGreedIndex();
  if (fg === null) return "both"; // No data = no filter
  if (fg <= 20) return "short"; // Extreme Fear: only shorts (trend-aligned)
  if (fg >= 80) return "long"; // Extreme Greed: only longs (trend-aligned)
  return "both";
}
