// Collect Hyperliquid hourly funding history for all 25 pairs.
// Caches to /tmp/hl-funding-cache/{PAIR}.json
// Run: npx tsx scripts/collect-hl-funding.ts

import * as fs from "fs";

const CACHE_DIR = "/tmp/hl-funding-cache";
fs.mkdirSync(CACHE_DIR, { recursive: true });

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA", "DOGE", "APT",
  "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL", "ZEC", "AVAX",
  "NEAR", "kPEPE", "SUI", "HYPE", "FET",
];

const START_MS = new Date("2023-01-01T00:00:00Z").getTime();
// HL returns at most ~5000 records per call (hourly = ~208 days per call)
const CHUNK_MS = 180 * 24 * 3600_000; // 180-day chunks to be safe

interface FundingBar {
  time: number;
  fundingRate: number;
}

async function fetchFundingChunk(coin: string, startTime: number): Promise<FundingBar[]> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "fundingHistory", coin, startTime }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((r: any) => ({
    time: typeof r.time === "number" ? r.time : parseInt(r.time, 10),
    fundingRate: parseFloat(r.fundingRate),
  }));
}

async function collectPair(coin: string): Promise<FundingBar[]> {
  const cacheFile = `${CACHE_DIR}/${coin}.json`;

  // Load existing cache
  let existing: FundingBar[] = [];
  try {
    existing = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
  } catch {
    // no cache
  }

  const lastTs = existing.length > 0 ? existing[existing.length - 1].time + 1 : START_MS;
  const now = Date.now();

  if (lastTs >= now - 3600_000) {
    // Already up to date (within 1h)
    return existing;
  }

  const newBars: FundingBar[] = [];
  let cursor = lastTs;
  let pages = 0;

  while (cursor < now) {
    let chunk: FundingBar[];
    try {
      chunk = await fetchFundingChunk(coin, cursor);
    } catch (err) {
      console.error(`  [${coin}] fetch error at ${new Date(cursor).toISOString()}: ${err}`);
      break;
    }

    if (chunk.length === 0) break;

    // Deduplicate against existing
    const seen = new Set(existing.map(b => b.time));
    for (const b of chunk) {
      if (!seen.has(b.time)) {
        newBars.push(b);
        seen.add(b.time);
      }
    }

    const lastChunkTs = chunk[chunk.length - 1].time;
    pages++;

    // If HL returned fewer than 100 bars, we've reached the end
    if (chunk.length < 100) break;

    // Advance cursor past last returned timestamp
    cursor = lastChunkTs + 1;

    // Rate limit: ~2 req/s is well within 1200 weight/min
    await new Promise(r => setTimeout(r, 500));
  }

  const merged = [...existing, ...newBars].sort((a, b) => a.time - b.time);

  // Deduplicate by timestamp
  const deduped: FundingBar[] = [];
  const seen = new Set<number>();
  for (const b of merged) {
    if (!seen.has(b.time)) {
      deduped.push(b);
      seen.add(b.time);
    }
  }

  fs.writeFileSync(cacheFile, JSON.stringify(deduped));
  return deduped;
}

async function main() {
  console.log(`Collecting HL funding history for ${PAIRS.length} pairs from 2023-01-01\n`);

  const results: Array<{ pair: string; bars: number; from: string; to: string }> = [];

  for (const pair of PAIRS) {
    process.stdout.write(`${pair.padEnd(8)} `);
    try {
      const bars = await collectPair(pair);
      const from = bars.length > 0 ? new Date(bars[0].time).toISOString().slice(0, 10) : "n/a";
      const to = bars.length > 0 ? new Date(bars[bars.length - 1].time).toISOString().slice(0, 10) : "n/a";
      results.push({ pair, bars: bars.length, from, to });
      console.log(`${String(bars.length).padStart(6)} bars  ${from} -> ${to}`);
    } catch (err) {
      console.log(`ERROR: ${err}`);
      results.push({ pair, bars: 0, from: "error", to: "error" });
    }
  }

  console.log("\n=== Summary ===");
  console.log("Pair     Bars    From        To");
  console.log("-".repeat(45));
  for (const r of results) {
    console.log(`${r.pair.padEnd(8)} ${String(r.bars).padStart(6)}  ${r.from}  ${r.to}`);
  }

  const total = results.reduce((s, r) => s + r.bars, 0);
  console.log(`\nTotal: ${total} bars across ${results.length} pairs`);
  console.log(`Cache: ${CACHE_DIR}/`);
}

main().catch(console.error);
