import { ensureConnected, getClient } from "./client.js";
import type { CandleInterval, OhlcvCandle } from "./types.js";

const INTERVAL_MS: Record<CandleInterval, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
};

export async function fetchCandles(
  pair: string,
  interval: CandleInterval,
  count: number,
): Promise<OhlcvCandle[]> {
  try {
    await ensureConnected();
    const sdk = getClient();

    const endTime = Date.now();
    const startTime = endTime - INTERVAL_MS[interval] * count;

    const raw = await sdk.info.getCandleSnapshot(pair, interval, startTime, endTime);

    const candles: OhlcvCandle[] = raw.map((c) => ({
      timestamp: c.t,
      open: parseFloat(String(c.o)),
      high: parseFloat(String(c.h)),
      low: parseFloat(String(c.l)),
      close: parseFloat(String(c.c)),
      volume: parseFloat(String(c.v)),
      trades: c.n,
    }));

    candles.sort((a, b) => a.timestamp - b.timestamp);

    console.log(`[Hyperliquid] Fetched ${candles.length} ${interval} candles for ${pair}`);
    return candles;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hyperliquid] Failed to fetch ${interval} candles for ${pair}: ${msg}`);
    return [];
  }
}

export async function fetchAllCandles(
  pair: string,
  count: number,
): Promise<Record<CandleInterval, OhlcvCandle[]>> {
  const [candles15m, candles1h, candles4h] = await Promise.all([
    fetchCandles(pair, "15m", count),
    fetchCandles(pair, "1h", count),
    fetchCandles(pair, "4h", count),
  ]);

  return {
    "15m": candles15m,
    "1h": candles1h,
    "4h": candles4h,
  };
}
