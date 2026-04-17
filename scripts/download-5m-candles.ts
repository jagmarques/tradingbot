/**
 * Downloads 5m candles from Binance for all QUANT_TRADING_PAIRS and caches them.
 *
 * Usage:
 *   npx tsx scripts/download-5m-candles.ts
 *
 * Output: /tmp/bt-pair-cache-5m/{PAIRUSDT}.json
 * Format: [{t, o, h, l, c, v}, ...]
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_DIR = "/tmp/bt-pair-cache-5m";
const RATE_LIMIT_DELAY_MS = 80;
const START_TIME = new Date("2023-01-01").getTime();
const END_TIME = new Date("2026-04-10").getTime();

// Missing from cache vs QUANT_TRADING_PAIRS (25 pairs).
// NOTE: HYPE is not on Binance, TRUMP/PEPE use 1000x prefix sometimes.
const PAIRS = [
  "BIOUSDT", "OMNIUSDT", "ORDIUSDT", "XAIUSDT", "SUSHIUSDT", "MEUSDT", "ZENUSDT",
  "TNSRUSDT", "CATIUSDT", "TURBOUSDT", "MOVEUSDT", "GALAUSDT", "STRKUSDT",
  "SAGAUSDT", "ILVUSDT", "GMXUSDT", "OMUSDT", "CYBERUSDT", "NTRNUSDT",
  "BOMEUSDT", "MEMEUSDT", "ANIMEUSDT", "BANANAUSDT", "ETCUSDT", "USUALUSDT",
  "UMAUSDT", "USTCUSDT", "MAVUSDT", "REZUSDT", "NOTUSDT", "PENGUUSDT",
  "BIGTIMEUSDT", "WCTUSDT", "EIGENUSDT", "MANTAUSDT", "POLYXUSDT", "WUSDT",
  "FXSUSDT", "GMTUSDT", "RSRUSDT", "PEOPLEUSDT", "YGGUSDT", "TRBUSDT",
  "ETHFIUSDT", "ENSUSDT", "OGNUSDT", "AXSUSDT", "MINAUSDT", "LISTAUSDT",
  "NEOUSDT", "AIUSDT", "SCRUSDT", "APEUSDT", "KAITOUSDT", "ARUSDT",
  "BNTUSDT", "PIXELUSDT", "LAYERUSDT", "ZROUSDT", "CELOUSDT", "ACEUSDT",
  "COMPUSDT", "RDNTUSDT", "ZKUSDT", "METUSDT", "STGUSDT", "REQUSDT",
  "CAKEUSDT", "SUPERUSDT", "FTTUSDT", "STRAXUSDT", "HYPEUSDT",
  "DYMUSDT", "CFXUSDT", "ALTUSDT", "SEISDT", "STXUSDT",
];

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function isFreshToday(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    const today = new Date();
    const modified = new Date(stat.mtimeMs);
    return (
      modified.getFullYear() === today.getFullYear() &&
      modified.getMonth() === today.getMonth() &&
      modified.getDate() === today.getDate()
    );
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadPair(sym: string): Promise<void> {
  const cacheFile = path.join(CACHE_DIR, `${sym}.json`);

  if (isFreshToday(cacheFile)) {
    console.log(`[5m] ${sym}: cache is fresh, skipping`);
    return;
  }

  console.log(`[5m] ${sym}: downloading...`);
  const allCandles: Candle[] = [];
  // 1000 candles * 5min per candle = 5000 min per chunk
  const chunkMs = 1000 * 5 * 60 * 1000;

  for (let t = START_TIME; t < END_TIME; t += chunkMs) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=5m` +
      `&startTime=${t}&limit=1000`;

    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        console.warn(`[5m] ${sym}: HTTP ${res.status} at ${new Date(t).toISOString()}`);
        break;
      }
      const raw = (await res.json()) as unknown[][];
      if (!Array.isArray(raw) || raw.length === 0) break;

      for (const r of raw) {
        allCandles.push({
          t: r[0] as number,
          o: +(r[1] as string),
          h: +(r[2] as string),
          l: +(r[3] as string),
          c: +(r[4] as string),
          v: +(r[5] as string),
        });
      }

      // If fewer than 1000 candles returned, we've reached the end
      if (raw.length < 1000) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[5m] ${sym}: fetch error - ${msg}`);
      break;
    }

    await sleep(RATE_LIMIT_DELAY_MS);
  }

  allCandles.sort((a, b) => a.t - b.t);
  fs.writeFileSync(cacheFile, JSON.stringify(allCandles));

  const startDate = allCandles[0]
    ? new Date(allCandles[0].t).toISOString().slice(0, 10)
    : "n/a";
  const endDate = allCandles[allCandles.length - 1]
    ? new Date(allCandles[allCandles.length - 1]!.t).toISOString().slice(0, 10)
    : "n/a";

  console.log(`[5m] ${sym}: ${allCandles.length} candles, ${startDate} to ${endDate}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(
    `[5m] Downloading ${PAIRS.length} pairs from ${new Date(START_TIME).toISOString().slice(0, 10)} to ${new Date(END_TIME).toISOString().slice(0, 10)}`,
  );
  console.log(`[5m] Cache dir: ${CACHE_DIR}`);
  console.log(`[5m] This will take 15-25 minutes...`);

  for (let i = 0; i < PAIRS.length; i++) {
    await downloadPair(PAIRS[i]!);
  }

  console.log("[5m] Done");
}

main().catch((err) => {
  console.error("[5m] Fatal:", err);
  process.exit(1);
});
