import { ADX } from "technicalindicators";

export interface DailyCandle {
  timestamp: number;
  close: number;
  high: number;
  low: number;
}

interface DailyCache {
  candles: DailyCandle[];
  fetchedAtHour: number;
}

const dailyCandleCache = new Map<string, Map<number, DailyCache>>();

export async function fetchDailyCandles(
  pair: string,
  lookbackDays: number,
): Promise<DailyCandle[]> {
  const nowHour = Math.floor(Date.now() / 3_600_000);

  if (!dailyCandleCache.has(pair)) {
    dailyCandleCache.set(pair, new Map());
  }
  const pairCache = dailyCandleCache.get(pair)!;
  const cached = pairCache.get(lookbackDays);
  if (cached && cached.fetchedAtHour === nowHour) return cached.candles;

  const endTime = Date.now();
  const startTime = endTime - lookbackDays * 86400_000;
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin: pair, interval: "1d", startTime, endTime },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as Array<{
      t: number;
      c: string;
      h: string;
      l: string;
    }>;
    const candles = raw
      .map((c) => ({
        timestamp: c.t,
        close: parseFloat(c.c),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
    pairCache.set(lookbackDays, { candles, fetchedAtHour: nowHour });
    return candles;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[DailyIndicators] Failed to fetch daily candles for ${pair}: ${msg}`,
    );
    return cached?.candles ?? [];
  }
}

export function computeDailySma(
  closes: number[],
  period: number,
  idx: number,
): number | null {
  if (idx < period - 1) return null;
  const slice = closes.slice(idx - period + 1, idx + 1);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/**
 * Computes proper Wilder-smoothed ADX using the technicalindicators library.
 * Returns the ADX at the last available bar (idx), or null if insufficient data.
 *
 * Previously engines used a non-Wilder simplified formula that overestimated ADX
 * by ~35% in sideways markets, causing false trend-strength signals.
 */
export function computeDailyAdx(
  candles: DailyCandle[],
  idx: number,
  period: number,
): number | null {
  // Need at least period*2+1 bars for ADX to stabilise
  if (idx < period * 2) return null;

  const slice = candles.slice(0, idx + 1);
  const highs = slice.map((c) => c.high);
  const lows = slice.map((c) => c.low);
  const closes = slice.map((c) => c.close);

  const adxResult = ADX.calculate({
    high: highs,
    low: lows,
    close: closes,
    period,
  });

  if (adxResult.length === 0) return null;
  const last = adxResult[adxResult.length - 1];
  return last?.adx ?? null;
}
