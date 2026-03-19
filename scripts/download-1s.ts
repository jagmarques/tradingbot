/**
 * Download 1-second candle data from Binance data.binance.vision
 * Saves to /tmp/bt-pair-cache-1s/{PAIR}.json
 *
 * Usage:
 *   npx tsx scripts/download-1s.ts                    # All pairs, last 90 days
 *   npx tsx scripts/download-1s.ts --pair BTCUSDT     # Single pair
 *   npx tsx scripts/download-1s.ts --days 30          # Last 30 days
 *   npx tsx scripts/download-1s.ts --from 2025-06-01  # From specific date
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const CACHE_DIR = "/tmp/bt-pair-cache-1s";
const TMP_DIR = "/tmp/bt-1s-download";
const BASE_URL = "https://data.binance.vision/data/spot/daily/klines";

const PAIRS = [
  "OPUSDT","WIFUSDT","ARBUSDT","LDOUSDT","AVAXUSDT","TRUMPUSDT","DASHUSDT",
  "DOTUSDT","ENAUSDT","DOGEUSDT","APTUSDT","SEIUSDT","LINKUSDT","ADAUSDT",
  "WLDUSDT","XRPUSDT","SUIUSDT","TONUSDT","UNIUSDT",
];

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

function parseArgs(): { pairs: string[]; fromDate: Date; toDate: Date } {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string): string => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
  };

  const pairArg = get("--pair", "");
  const pairs = pairArg
    ? pairArg.split(",").map(p => p.toUpperCase().endsWith("USDT") ? p.toUpperCase() : p.toUpperCase() + "USDT")
    : PAIRS;

  const days = parseInt(get("--days", "90"));
  const fromStr = get("--from", "");
  const toDate = new Date();
  toDate.setDate(toDate.getDate() - 1); // Yesterday (today's file may not exist yet)

  let fromDate: Date;
  if (fromStr) {
    fromDate = new Date(fromStr);
  } else {
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
  }

  return { pairs, fromDate, toDate };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getDaysBetween(from: Date, to: Date): string[] {
  const dates: string[] = [];
  const current = new Date(from);
  while (current <= to) {
    dates.push(formatDate(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function downloadDay(pair: string, date: string): Promise<Candle[]> {
  const url = `${BASE_URL}/${pair}/1s/${pair}-1s-${date}.zip`;
  const zipPath = path.join(TMP_DIR, `${pair}-${date}.zip`);
  const csvPath = path.join(TMP_DIR, `${pair}-1s-${date}.csv`);

  try {
    // Download ZIP
    execSync(`curl -sS -o "${zipPath}" "${url}"`, { timeout: 30000 });

    // Check if download succeeded (curl returns 0 even on 404)
    const stat = fs.statSync(zipPath);
    if (stat.size < 100) {
      fs.unlinkSync(zipPath);
      return []; // File not available yet
    }

    // Unzip
    execSync(`unzip -o -q "${zipPath}" -d "${TMP_DIR}"`, { timeout: 30000 });
    fs.unlinkSync(zipPath);

    if (!fs.existsSync(csvPath)) return [];

    // Parse CSV: timestamp,open,high,low,close,volume,closeTime,quoteVol,trades,takerBuyBase,takerBuyQuote,ignore
    const raw = fs.readFileSync(csvPath, "utf8");
    fs.unlinkSync(csvPath);

    const candles: Candle[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const cols = line.split(",");
      if (cols.length < 5) continue;

      const t = parseInt(cols[0]);
      if (isNaN(t)) continue;

      // Binance spot data from 2025+ may use microsecond timestamps
      const timestamp = t > 1e15 ? Math.floor(t / 1000) : t;

      candles.push({
        t: timestamp,
        o: parseFloat(cols[1]),
        h: parseFloat(cols[2]),
        l: parseFloat(cols[3]),
        c: parseFloat(cols[4]),
      });
    }

    return candles;
  } catch {
    // Clean up on error
    try { fs.unlinkSync(zipPath); } catch { /* */ }
    try { fs.unlinkSync(csvPath); } catch { /* */ }
    return [];
  }
}

async function downloadPair(pair: string, dates: string[]): Promise<number> {
  const existingPath = path.join(CACHE_DIR, `${pair}.json`);
  let existing: Candle[] = [];

  if (fs.existsSync(existingPath)) {
    existing = JSON.parse(fs.readFileSync(existingPath, "utf8")) as Candle[];
  }

  const lastTs = existing.length > 0 ? existing[existing.length - 1].t : 0;
  let newCandles = 0;

  for (const date of dates) {
    const dateTs = new Date(date).getTime();
    // Skip dates we already have
    if (dateTs + 86400000 < lastTs) continue;

    process.stdout.write(`  ${pair} ${date}...`);
    const dayCandles = await downloadDay(pair, date);

    if (dayCandles.length === 0) {
      process.stdout.write(" skip\n");
      continue;
    }

    // Merge: only add candles newer than what we have
    const fresh = dayCandles.filter(c => c.t > lastTs);
    existing.push(...fresh);
    newCandles += fresh.length;
    process.stdout.write(` ${fresh.length} candles\n`);
  }

  if (newCandles > 0) {
    // Sort and deduplicate
    existing.sort((a, b) => a.t - b.t);
    const deduped: Candle[] = [];
    let prevT = 0;
    for (const c of existing) {
      if (c.t !== prevT) {
        deduped.push(c);
        prevT = c.t;
      }
    }

    fs.writeFileSync(existingPath, JSON.stringify(deduped));
    const sizeMB = (fs.statSync(existingPath).size / 1e6).toFixed(1);
    console.log(`  ${pair}: ${deduped.length} total candles (${sizeMB}MB)`);
  }

  return newCandles;
}

async function main(): Promise<void> {
  const { pairs, fromDate, toDate } = parseArgs();
  const dates = getDaysBetween(fromDate, toDate);

  console.log(`Downloading 1s candles: ${pairs.length} pairs, ${dates.length} days`);
  console.log(`Range: ${formatDate(fromDate)} -> ${formatDate(toDate)}`);
  console.log(`Cache: ${CACHE_DIR}\n`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  let totalNew = 0;
  for (const pair of pairs) {
    const n = await downloadPair(pair, dates);
    totalNew += n;
  }

  // Cleanup tmp
  try { fs.rmSync(TMP_DIR, { recursive: true }); } catch { /* */ }

  console.log(`\nDone: ${totalNew} new candles across ${pairs.length} pairs`);
}

main().catch(err => { console.error(err); process.exit(1); });
