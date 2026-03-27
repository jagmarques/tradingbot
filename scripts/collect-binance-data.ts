// Collect Binance derivatives data (long/short ratio, top trader L/S, taker buy/sell).
// Appends to existing JSON files, deduplicates by timestamp, sorts ascending.
// Run daily to accumulate history for backtesting.
//
// Run: npx tsx scripts/collect-binance-data.ts

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Constants ────────────────────────────────────────────────────────────────

const OUT_DIR = "/tmp/binance-history";

const PAIRS = [
  "BTC", "ETH", "SOL", "XRP", "DOGE", "LINK", "DOT", "ADA",
  "ARB", "UNI", "APT", "WLD", "OP", "LDO", "ENA", "WIF", "DASH", "AVAX",
];

const SIGNALS: { key: string; endpoint: string }[] = [
  {
    key: "longShortRatio",
    endpoint: "https://fapi.binance.com/futures/data/globalLongShortAccountRatio",
  },
  {
    key: "topTraderLongShort",
    endpoint: "https://fapi.binance.com/futures/data/topLongShortPositionRatio",
  },
  {
    key: "takerBuySell",
    endpoint: "https://fapi.binance.com/futures/data/takerlongshortRatio",
  },
];

const LIMIT = 500;
const PERIOD = "4h";
const DELAY_MS = 200;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DataRecord {
  timestamp: number;
  [key: string]: unknown;
}

function loadExisting(filePath: string): DataRecord[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DataRecord[];
  } catch {
    return [];
  }
}

function mergeAndDedupe(existing: DataRecord[], incoming: DataRecord[]): { merged: DataRecord[]; newCount: number } {
  const seen = new Set<number>();
  for (const r of existing) {
    seen.add(Number(r.timestamp));
  }

  let newCount = 0;
  const combined = [...existing];
  for (const r of incoming) {
    const ts = Number(r.timestamp);
    if (!seen.has(ts)) {
      seen.add(ts);
      combined.push(r);
      newCount++;
    }
  }

  combined.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  return { merged: combined, newCount };
}

async function fetchSignal(pair: string, signal: typeof SIGNALS[number]): Promise<DataRecord[]> {
  const url = `${signal.endpoint}?symbol=${pair}USDT&period=${PERIOD}&limit=${LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    console.error(`  [FAIL] ${pair} ${signal.key}: HTTP ${res.status} - ${text.slice(0, 120)}`);
    return [];
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error(`  [FAIL] ${pair} ${signal.key}: unexpected response shape`);
    return [];
  }
  return data as DataRecord[];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[Collector] Starting Binance data collection`);
  console.log(`[Collector] Pairs: ${PAIRS.length}, Signals: ${SIGNALS.length}`);
  console.log(`[Collector] Output: ${OUT_DIR}\n`);

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  let totalNew = 0;
  let totalRecords = 0;
  let requestCount = 0;

  for (const pair of PAIRS) {
    console.log(`[${pair}]`);

    for (const signal of SIGNALS) {
      if (requestCount > 0) await sleep(DELAY_MS);
      requestCount++;

      const incoming = await fetchSignal(pair, signal);
      if (incoming.length === 0) continue;

      const fileName = `${pair}_${signal.key}.json`;
      const filePath = path.join(OUT_DIR, fileName);

      const existing = loadExisting(filePath);
      const { merged, newCount } = mergeAndDedupe(existing, incoming);

      fs.writeFileSync(filePath, JSON.stringify(merged, null, 0));

      totalNew += newCount;
      totalRecords += merged.length;

      const firstTs = merged.length > 0 ? new Date(Number(merged[0].timestamp)).toISOString().slice(0, 10) : "?";
      const lastTs = merged.length > 0 ? new Date(Number(merged[merged.length - 1].timestamp)).toISOString().slice(0, 10) : "?";

      console.log(`  ${signal.key}: +${newCount} new, ${merged.length} total (${firstTs} to ${lastTs})`);
    }
  }

  console.log(`\n[Collector] Done. ${totalNew} new records added, ${totalRecords} total across all files.`);

  // Summary: disk usage
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".json"));
  const totalBytes = files.reduce((sum, f) => sum + fs.statSync(path.join(OUT_DIR, f)).size, 0);
  console.log(`[Collector] ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB on disk.`);
}

main().catch((err) => {
  console.error("[Collector] Fatal error:", err);
  process.exit(1);
});
