/**
 * Downloads historical funding rates from Hyperliquid and caches them as JSON.
 *
 * Usage:
 *   npx tsx scripts/download-funding.ts [--pairs BTC,ETH,SOL] [--start 2024-01-01] [--cache-dir /tmp/bt-funding-cache]
 */

import * as fs from "fs";
import * as path from "path";
import { Hyperliquid } from "hyperliquid";
import type { FundingEntry } from "../src/services/backtest/types.js";

// Default pairs: QUANT_TRADING_PAIRS short names + BTC, ETH, SOL, TIA
const DEFAULT_PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI",
  "BTC", "ETH", "SOL", "TIA",
];

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const RATE_LIMIT_DELAY_MS = 200;

function parseArgs(): { pairs: string[]; startTime: number; cacheDir: string } {
  const args = process.argv.slice(2);
  let pairs = DEFAULT_PAIRS;
  let startTime = new Date("2024-01-01").getTime();
  let cacheDir = "/tmp/bt-funding-cache";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pairs" && args[i + 1]) {
      pairs = args[i + 1]!.split(",").map((p) => p.trim());
      i++;
    } else if (args[i] === "--start" && args[i + 1]) {
      const parsed = new Date(args[i + 1]!).getTime();
      if (!isNaN(parsed)) startTime = parsed;
      i++;
    } else if (args[i] === "--cache-dir" && args[i + 1]) {
      cacheDir = args[i + 1]!;
      i++;
    }
  }

  return { pairs, startTime, cacheDir };
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

function forwardFill(entries: FundingEntry[]): { filled: FundingEntry[]; gapCount: number } {
  if (entries.length === 0) return { filled: [], gapCount: 0 };

  const filled: FundingEntry[] = [entries[0]!];
  let gapCount = 0;

  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const curr = entries[i]!;
    const gap = curr.time - prev.time;

    if (gap > TWO_HOURS_MS) {
      if (gap > FOUR_HOURS_MS) {
        console.warn(
          `[Funding] WARNING: gap of ${(gap / 3600000).toFixed(1)}h at ${new Date(prev.time).toISOString()}`,
        );
      }
      // Forward-fill with 1h intervals
      let t = prev.time + 60 * 60 * 1000;
      while (t < curr.time) {
        filled.push({ time: t, rate: prev.rate });
        t += 60 * 60 * 1000;
        gapCount++;
      }
    }

    filled.push(curr);
  }

  return { filled, gapCount };
}

const API_PAGE_SIZE = 500; // Hyperliquid returns max 500 entries per call

async function fetchAllFundingHistory(
  sdk: Hyperliquid,
  pair: string,
  startTime: number,
): Promise<FundingEntry[]> {
  const all: FundingEntry[] = [];
  let cursor = startTime;
  const now = Date.now();

  while (cursor < now) {
    const raw = await sdk.info.perpetuals.getFundingHistory(pair, cursor, undefined, true);

    if (!Array.isArray(raw) || raw.length === 0) break;

    const batch: FundingEntry[] = raw.map((e) => ({
      time: e.time,
      rate: parseFloat(e.fundingRate),
    }));

    all.push(...batch);

    if (raw.length < API_PAGE_SIZE) break; // last page

    // Advance cursor past the last entry to avoid duplicates
    cursor = raw[raw.length - 1]!.time + 1;
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return all;
}

async function downloadPair(
  sdk: Hyperliquid,
  pair: string,
  startTime: number,
  cacheDir: string,
): Promise<void> {
  const cacheFile = path.join(cacheDir, `${pair}_funding.json`);

  if (isFreshToday(cacheFile)) {
    console.log(`[Funding] ${pair}: cache is fresh, skipping`);
    return;
  }

  try {
    const entries = await fetchAllFundingHistory(sdk, pair, startTime);

    if (entries.length === 0) {
      console.warn(`[Funding] ${pair}: no data returned`);
      return;
    }

    const { filled, gapCount } = forwardFill(entries);

    fs.writeFileSync(cacheFile, JSON.stringify(filled, null, 0));

    const startDate = new Date(filled[0]!.time).toISOString().slice(0, 10);
    const endDate = new Date(filled[filled.length - 1]!.time).toISOString().slice(0, 10);
    console.log(
      `[Funding] ${pair}: ${filled.length} entries, ${startDate} to ${endDate}, ${gapCount} gaps filled`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Funding] ${pair}: failed - ${msg}`);
  }
}

async function main(): Promise<void> {
  const { pairs, startTime, cacheDir } = parseArgs();

  fs.mkdirSync(cacheDir, { recursive: true });

  console.log(
    `[Funding] Downloading ${pairs.length} pairs from ${new Date(startTime).toISOString().slice(0, 10)} to cache: ${cacheDir}`,
  );

  const sdk = new Hyperliquid({ enableRateLimiting: true });

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    await downloadPair(sdk, pair, startTime, cacheDir);
    if (i < pairs.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log("[Funding] Done");
}

main().catch((err) => {
  console.error("[Funding] Fatal:", err);
  process.exit(1);
});
