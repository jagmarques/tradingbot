/**
 * Downloads 1m candles from Binance for all pairs (OOS period + warmup)
 * Output: /tmp/bt-pair-cache-1m/{PAIRUSDT}.json
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_DIR = "/tmp/bt-pair-cache-1m";
const RATE_LIMIT_DELAY_MS = 80;
// Need warmup for indicators (50 1h bars = 50h before OOS start)
const START_TIME = new Date("2025-04-01").getTime();
const END_TIME = new Date("2026-04-10").getTime();

const RENAME: Record<string, string> = { kPEPE: "1000PEPE" };

const ALL_PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT","LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL",
  "ZEC","AVAX","NEAR","kPEPE","SUI","FET","FIL","ALGO","BCH","JTO","SAND","BLUR","TAO","RENDER","TRX","AAVE",
  "JUP","POL","CRV","PYTH","IMX","BNB","ONDO","XLM","DYDX","ICP","LTC","MKR","PENDLE","PNUT","ATOM","TON","SEI","STX",
  "DYM","CFX","ALT","BIO","OMNI","ORDI","XAI","SUSHI","ME","ZEN","TNSR","CATI","TURBO","MOVE","GALA","STRK","SAGA","ILV","GMX","OM",
  "CYBER","NTRN","BOME","MEME","ANIME","BANANA","ETC","USUAL","UMA","USTC","MAV","REZ","NOT","PENGU","BIGTIME","WCT","EIGEN","MANTA","POLYX","W",
  "FXS","GMT","RSR","PEOPLE","YGG","TRB","ETHFI","ENS","OGN","AXS","MINA","LISTA","NEO","AI","SCR","APE","KAITO","AR","BNT","PIXEL",
  "LAYER","ZRO","CELO","ACE","COMP","RDNT","ZK","MET","STG","REQ","CAKE","SUPER","FTT","STRAX",
];

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFreshToday(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    const today = new Date();
    const modified = new Date(stat.mtimeMs);
    return modified.getFullYear() === today.getFullYear() &&
      modified.getMonth() === today.getMonth() &&
      modified.getDate() === today.getDate();
  } catch { return false; }
}

async function downloadPair(sym: string): Promise<void> {
  const cacheFile = path.join(CACHE_DIR, `${sym}.json`);
  if (isFreshToday(cacheFile)) {
    console.log(`[1m] ${sym}: cache is fresh, skipping`);
    return;
  }

  console.log(`[1m] ${sym}: downloading...`);
  const allCandles: Candle[] = [];
  const chunkMs = 1000 * 1 * 60 * 1000; // 1000 candles * 1min

  for (let t = START_TIME; t < END_TIME; t += chunkMs) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m` +
      `&startTime=${t}&limit=1000`;

    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        console.warn(`[1m] ${sym}: HTTP ${res.status}`);
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

      if (raw.length < 1000) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[1m] ${sym}: fetch error - ${msg}`);
      break;
    }

    await sleep(RATE_LIMIT_DELAY_MS);
  }

  allCandles.sort((a, b) => a.t - b.t);
  fs.writeFileSync(cacheFile, JSON.stringify(allCandles));

  const startDate = allCandles[0] ? new Date(allCandles[0].t).toISOString().slice(0, 10) : "n/a";
  const endDate = allCandles[allCandles.length - 1] ? new Date(allCandles[allCandles.length - 1]!.t).toISOString().slice(0, 10) : "n/a";
  console.log(`[1m] ${sym}: ${allCandles.length} candles, ${startDate} to ${endDate}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const symbols: string[] = [];
  for (const name of ALL_PAIRS) {
    const sym = RENAME[name] ?? name;
    symbols.push(`${sym}USDT`);
  }

  console.log(`[1m] Downloading ${symbols.length} pairs (1m candles, ${new Date(START_TIME).toISOString().slice(0, 10)} to ${new Date(END_TIME).toISOString().slice(0, 10)})`);
  console.log(`[1m] ~530k candles per pair, ~530 requests each. This will take 1-2 hours.`);

  for (let i = 0; i < symbols.length; i++) {
    console.log(`[1m] Progress: ${i + 1}/${symbols.length}`);
    await downloadPair(symbols[i]!);
  }

  console.log("[1m] Done");
}

main().catch((err) => {
  console.error("[1m] Fatal:", err);
  process.exit(1);
});
