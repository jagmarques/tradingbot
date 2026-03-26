import * as fs from "fs";
import * as path from "path";

const HL_API = "https://api.hyperliquid.xyz/info";
const CACHE_DIR = "/tmp/bt-pair-cache-1h";
// HL only has 1h candle data from ~2025-08-29 onwards
const START = new Date("2025-08-28").getTime();
const END = Date.now();
const BATCH_SIZE = 1000; // candles per request
const DELAY_MS = 500; // delay between requests
const RETRY_DELAY_MS = 5000; // delay on failure
const TOP_N = 30;

type Candle = [number, number, number, number, number]; // [t, o, h, l, c]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function hlPost(body: object, retries = 1): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(HL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt < retries) {
        console.log(`  Request failed, retrying in ${RETRY_DELAY_MS / 1000}s... (${(err as Error).message})`);
        await sleep(RETRY_DELAY_MS);
      } else {
        throw err;
      }
    }
  }
}

interface AssetInfo {
  coin: string;
  dayNtlVlm: number;
}

async function getTopPairs(): Promise<AssetInfo[]> {
  console.log("Fetching all pairs from Hyperliquid...");
  const data = await hlPost({ type: "metaAndAssetCtxs" });
  const meta = data[0]; // universe
  const ctxs = data[1]; // assetCtxs

  const assets: AssetInfo[] = [];
  for (let i = 0; i < meta.universe.length; i++) {
    const coin = meta.universe[i].name as string;
    const ctx = ctxs[i];
    const vol = parseFloat(ctx.dayNtlVlm || "0");
    assets.push({ coin, dayNtlVlm: vol });
  }

  assets.sort((a, b) => b.dayNtlVlm - a.dayNtlVlm);
  return assets;
}

async function downloadCandles(coin: string): Promise<Candle[]> {
  const allCandles: Candle[] = [];
  let cursor = START;
  const oneHourMs = 3600000;
  let emptyStreak = 0;

  while (cursor < END) {
    const batchEnd = Math.min(cursor + BATCH_SIZE * oneHourMs, END);

    const data = await hlPost({
      type: "candleSnapshot",
      req: { coin, interval: "1h", startTime: cursor, endTime: batchEnd },
    });

    if (!Array.isArray(data) || data.length === 0) {
      // Skip forward by one batch window and try again
      cursor = batchEnd;
      emptyStreak++;
      if (emptyStreak >= 3) break; // give up after 3 empty batches in a row
      await sleep(DELAY_MS);
      continue;
    }
    emptyStreak = 0;

    for (const c of data) {
      allCandles.push([c.t, parseFloat(c.o), parseFloat(c.h), parseFloat(c.l), parseFloat(c.c)]);
    }

    const lastT = data[data.length - 1].t;
    if (lastT <= cursor) break; // no progress
    cursor = lastT + oneHourMs;

    await sleep(DELAY_MS);
  }

  // Sort and deduplicate by timestamp
  allCandles.sort((a, b) => a[0] - b[0]);
  const seen = new Set<number>();
  const deduped: Candle[] = [];
  for (const c of allCandles) {
    if (!seen.has(c[0])) {
      seen.add(c[0]);
      deduped.push(c);
    }
  }

  return deduped;
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

async function main() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  // Step 1: Get all pairs
  const allAssets = await getTopPairs();
  console.log(`\nTotal pairs available on Hyperliquid: ${allAssets.length}`);

  // Step 2: Top 30
  const top = allAssets.slice(0, TOP_N);
  console.log(`\nTop ${TOP_N} by 24h volume:`);
  console.log("Rank  Coin          24h Volume");
  console.log("-".repeat(42));
  for (let i = 0; i < top.length; i++) {
    console.log(
      `${String(i + 1).padStart(3)}   ${top[i].coin.padEnd(12)}  ${fmtVol(top[i].dayNtlVlm).padStart(10)}`
    );
  }

  // Step 3: Download candles
  console.log(`\nDownloading 1h candles from ${new Date(START).toISOString().split("T")[0]} to ${new Date(END).toISOString().split("T")[0]}...`);
  console.log(`Cache dir: ${CACHE_DIR}\n`);

  const results: { pair: string; count: number; ok: boolean }[] = [];
  let totalCandles = 0;

  for (const asset of top) {
    const filename = `${asset.coin}USDT.json`;
    const filepath = path.join(CACHE_DIR, filename);

    try {
      const candles = await downloadCandles(asset.coin);
      if (candles.length > 0) {
        fs.writeFileSync(filepath, JSON.stringify(candles));
        console.log(`Downloaded ${asset.coin}: ${candles.length} candles`);
        results.push({ pair: asset.coin, count: candles.length, ok: true });
        totalCandles += candles.length;
      } else {
        console.log(`Downloaded ${asset.coin}: 0 candles (skipped)`);
        results.push({ pair: asset.coin, count: 0, ok: false });
      }
    } catch (err) {
      console.log(`FAILED ${asset.coin}: ${(err as Error).message}`);
      results.push({ pair: asset.coin, count: 0, ok: false });
    }
  }

  // Step 4: Report
  console.log("\n" + "=".repeat(50));
  console.log("DOWNLOAD REPORT");
  console.log("=".repeat(50));
  console.log(`Total pairs on Hyperliquid: ${allAssets.length}`);
  console.log(`Top ${TOP_N} downloaded:`);

  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);

  console.log(`  Successful: ${ok.length}`);
  if (fail.length > 0) {
    console.log(`  Failed: ${fail.length} (${fail.map((f) => f.pair).join(", ")})`);
  }
  console.log(`Total candles: ${totalCandles.toLocaleString()}`);

  // Date range per pair
  console.log("\nPair         Candles    From          To");
  console.log("-".repeat(58));
  for (const r of results.filter((r) => r.ok)) {
    const data: Candle[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${r.pair}USDT.json`), "utf8"));
    const from = new Date(data[0][0]).toISOString().split("T")[0];
    const to = new Date(data[data.length - 1][0]).toISOString().split("T")[0];
    console.log(`${r.pair.padEnd(12)} ${String(r.count).padStart(6)}    ${from}    ${to}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
