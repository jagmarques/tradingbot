/**
 * Download additional candle data from Hyperliquid.
 *
 * 1. Query HL for all available pairs (metaAndAssetCtxs)
 * 2. Rank by 24h volume, identify new high-volume pairs
 * 3. Download 1h candles (2024-01 to now) for top 30 + existing 19 pairs
 * 4. Save to /tmp/bt-pair-cache-1h/
 *
 * Run: cd <repo> && npx tsx scripts/download-more-data.ts
 */

import * as fs from "fs";
import * as path from "path";

const CACHE_DIR = "/tmp/bt-pair-cache-1h";
const EXISTING_5M_DIR = "/tmp/bt-pair-cache-5m";
const HL_URL = "https://api.hyperliquid.xyz/info";
const START_MS = new Date("2024-01-01T00:00:00Z").getTime();
const CHUNK_DAYS = 14; // download in 14-day chunks to avoid HL limits
const CHUNK_MS = CHUNK_DAYS * 86_400_000;
const DELAY_MS = 350; // rate-limit delay between requests

interface AssetMeta {
  name: string;
}

interface AssetCtx {
  dayNtlVlm: string;
  openInterest: string;
  funding: string;
  markPx: string;
}

interface PairInfo {
  coin: string;
  volume24h: number;
  openInterest: number;
  funding: number;
  markPx: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJSON(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(HL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Step 1: get all pairs from HL ─────────────────────────────────────────────

async function fetchAllPairs(): Promise<PairInfo[]> {
  const data = (await fetchJSON({ type: "metaAndAssetCtxs" })) as [
    { universe: AssetMeta[] },
    AssetCtx[],
  ];
  const metas = data[0].universe;
  const ctxs = data[1];
  const pairs: PairInfo[] = [];
  for (let i = 0; i < metas.length; i++) {
    const coin = metas[i].name;
    const ctx = ctxs[i];
    pairs.push({
      coin,
      volume24h: parseFloat(ctx.dayNtlVlm || "0"),
      openInterest: parseFloat(ctx.openInterest || "0") * parseFloat(ctx.markPx || "0"),
      funding: parseFloat(ctx.funding || "0"),
      markPx: parseFloat(ctx.markPx || "0"),
    });
  }
  return pairs.sort((a, b) => b.volume24h - a.volume24h);
}

// ─── Step 3: download 1h candles ───────────────────────────────────────────────

async function downloadCandles(coin: string): Promise<number[][]> {
  const endMs = Date.now();
  const allCandles: number[][] = [];
  let cursor = START_MS;

  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + CHUNK_MS, endMs);
    const body = {
      type: "candleSnapshot",
      req: { coin, interval: "1h", startTime: cursor, endTime: chunkEnd },
    };

    try {
      const raw = (await fetchJSON(body)) as Array<{
        t: number;
        o: string;
        h: string;
        l: string;
        c: string;
        v: string;
      }>;
      for (const c of raw) {
        allCandles.push([c.t, parseFloat(c.o), parseFloat(c.h), parseFloat(c.l), parseFloat(c.c)]);
      }
    } catch (err) {
      console.error(`  [WARN] chunk ${new Date(cursor).toISOString().slice(0, 10)} failed for ${coin}: ${err}`);
    }

    cursor = chunkEnd;
    await sleep(DELAY_MS);
  }

  // deduplicate by timestamp and sort
  const seen = new Set<number>();
  const deduped: number[][] = [];
  for (const c of allCandles) {
    if (!seen.has(c[0])) {
      seen.add(c[0]);
      deduped.push(c);
    }
  }
  deduped.sort((a, b) => a[0] - b[0]);
  return deduped;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Ensure output directory
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Step 1: fetch all HL pairs
  console.log("Step 1: Fetching all Hyperliquid pairs...\n");
  const allPairs = await fetchAllPairs();
  console.log(`Total pairs available on Hyperliquid: ${allPairs.length}\n`);

  // Step 2: identify existing pairs in 5m cache
  const existing5m = new Set<string>();
  if (fs.existsSync(EXISTING_5M_DIR)) {
    for (const f of fs.readdirSync(EXISTING_5M_DIR)) {
      if (f.endsWith("USDT.json")) {
        existing5m.add(f.replace("USDT.json", ""));
      }
    }
  }
  console.log(`Existing pairs in 5m cache: ${[...existing5m].join(", ")} (${existing5m.size})\n`);

  // Top 30 by volume
  const top30 = allPairs.slice(0, 30);

  // Show top 30 table
  console.log("Top 30 pairs by 24h volume:");
  console.log(
    `${"#".padStart(3)}  ${"Coin".padEnd(10)}  ${"24h Vol ($M)".padStart(14)}  ${"OI ($M)".padStart(12)}  ${"Funding (%)".padStart(12)}  ${"In 5m?".padEnd(6)}`,
  );
  console.log("-".repeat(70));
  for (let i = 0; i < top30.length; i++) {
    const p = top30[i];
    const in5m = existing5m.has(p.coin) || existing5m.has("k" + p.coin);
    console.log(
      `${String(i + 1).padStart(3)}  ${p.coin.padEnd(10)}  ${(p.volume24h / 1e6).toFixed(2).padStart(14)}  ${(p.openInterest / 1e6).toFixed(2).padStart(12)}  ${(p.funding * 100).toFixed(4).padStart(12)}  ${in5m ? "YES" : "NEW"}`,
    );
  }

  // Also show pairs 31-50 that have >$10M volume
  const extraHighVol = allPairs.slice(30).filter((p) => p.volume24h > 10_000_000);
  if (extraHighVol.length > 0) {
    console.log(`\nAdditional pairs (#31+) with >$10M volume: ${extraHighVol.length}`);
    for (const p of extraHighVol.slice(0, 20)) {
      const in5m = existing5m.has(p.coin) || existing5m.has("k" + p.coin);
      console.log(
        `     ${p.coin.padEnd(10)}  ${(p.volume24h / 1e6).toFixed(2).padStart(14)}  ${in5m ? "YES" : "NEW"}`,
      );
    }
  }

  // Determine which coins to download
  const toDownload = new Set<string>();

  // All top 30
  for (const p of top30) toDownload.add(p.coin);

  // All existing 5m pairs (use raw coin name for HL, not the kXXX format)
  // Map our 5m cache names to HL coin names
  for (const name of existing5m) {
    // kPEPE -> PEPE, kBONK -> BONK, etc.
    const hlName = name.startsWith("k") ? name.slice(1) : name;
    // Verify it exists on HL
    if (allPairs.find((p) => p.coin === hlName)) {
      toDownload.add(hlName);
    } else if (allPairs.find((p) => p.coin === name)) {
      toDownload.add(name);
    }
  }

  // Remove BTC - too large and typically used as reference separately
  // Actually keep BTC, it is useful for cross-pair analysis

  const downloadList = [...toDownload].sort();
  console.log(`\nWill download 1h candles for ${downloadList.length} pairs: ${downloadList.join(", ")}`);
  console.log(`Date range: 2024-01-01 to now (${((Date.now() - START_MS) / 86_400_000).toFixed(0)} days)\n`);

  // Check which already exist in 1h cache
  const alreadyCached = new Set<string>();
  if (fs.existsSync(CACHE_DIR)) {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.endsWith("USDT.json")) {
        alreadyCached.add(f.replace("USDT.json", ""));
      }
    }
  }

  // Step 3: download
  let totalCandles = 0;
  let downloaded = 0;
  let skipped = 0;
  const newPairs: string[] = [];

  for (const coin of downloadList) {
    const cacheFile = path.join(CACHE_DIR, `${coin}USDT.json`);

    // Check if we already have a recent cache
    if (fs.existsSync(cacheFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as number[][];
        const lastTs = existing.length > 0 ? existing[existing.length - 1][0] : 0;
        const ageHours = (Date.now() - lastTs) / 3_600_000;
        if (ageHours < 48 && existing.length > 5000) {
          console.log(
            `  [SKIP] ${coin.padEnd(8)} - already cached (${existing.length} candles, ${ageHours.toFixed(0)}h old)`,
          );
          totalCandles += existing.length;
          skipped++;
          continue;
        }
      } catch {
        // corrupt file, re-download
      }
    }

    process.stdout.write(`  [DL]   ${coin.padEnd(8)} - downloading...`);
    try {
      const candles = await downloadCandles(coin);
      if (candles.length === 0) {
        console.log(` 0 candles (pair may not exist since 2024-01)`);
        continue;
      }
      fs.writeFileSync(cacheFile, JSON.stringify(candles));
      console.log(
        ` ${candles.length} candles (${new Date(candles[0][0]).toISOString().slice(0, 10)} to ${new Date(candles[candles.length - 1][0]).toISOString().slice(0, 10)})`,
      );
      totalCandles += candles.length;
      downloaded++;
      if (!existing5m.has(coin) && !existing5m.has("k" + coin)) {
        newPairs.push(coin);
      }
    } catch (err) {
      console.log(` FAILED: ${err}`);
    }
  }

  // Step 4: report
  console.log("\n" + "=".repeat(70));
  console.log("DOWNLOAD REPORT");
  console.log("=".repeat(70));
  console.log(`Total pairs on Hyperliquid:  ${allPairs.length}`);
  console.log(`Pairs with >$10M volume:     ${allPairs.filter((p) => p.volume24h > 10_000_000).length}`);
  console.log(`Pairs downloaded:            ${downloaded}`);
  console.log(`Pairs skipped (cached):      ${skipped}`);
  console.log(`Total 1h candles:            ${totalCandles.toLocaleString()}`);
  console.log(`New pairs (not in 5m cache): ${newPairs.length > 0 ? newPairs.join(", ") : "(none)"}`);
  console.log(`Cache directory:             ${CACHE_DIR}`);

  // List final cache contents
  const finalFiles = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  console.log(`\nFinal cache: ${finalFiles.length} files`);
  for (const f of finalFiles.sort()) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8")) as number[][];
      const first = data.length > 0 ? new Date(data[0][0]).toISOString().slice(0, 10) : "?";
      const last = data.length > 0 ? new Date(data[data.length - 1][0]).toISOString().slice(0, 10) : "?";
      console.log(`  ${f.padEnd(20)} ${String(data.length).padStart(7)} candles  ${first} -> ${last}`);
    } catch {
      console.log(`  ${f.padEnd(20)} [error reading]`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
