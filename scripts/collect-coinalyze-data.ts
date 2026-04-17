/**
 * Coinalyze Historical Data Collector
 *
 * Downloads OI, funding rate, liquidation, and long/short ratio history
 * for all trading pairs from the Coinalyze free API.
 *
 * Endpoints used (base: https://api.coinalyze.net/v1):
 *   /open-interest-history    -- daily + 4h granularity
 *   /funding-rate-history     -- 8h intervals
 *   /liquidation-history      -- daily
 *   /long-short-ratio-history -- daily
 *
 * Auth: COINALYZE_API_KEY env var (header: api_key)
 * Rate limit: 40 calls/min per API key
 * Cache: /tmp/coinalyze-cache/<pair>_<metric>_<interval>.json
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/collect-coinalyze-data.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Config ─────────────────────────────────────────────────────────

const API_KEY = process.env.COINALYZE_API_KEY ?? "";
const BASE_URL = "https://api.coinalyze.net/v1";
const CACHE_DIR = "/tmp/coinalyze-cache";

// 40 calls/min => 1 call per 1500ms to stay safely under limit
const RATE_LIMIT_MS = 1_500;

// History window
const FROM_DATE = new Date("2023-01-01").getTime() / 1000; // Unix seconds
const TO_DATE = Math.floor(Date.now() / 1000);

// Trading pairs (HL base names -> Binance USDT perp symbol for Coinalyze)
// Coinalyze uses Binance perpetual symbols like "BTCUSDT_PERP.A"
// Exchange code: .A = Binance, .6 = Bybit, .3 = OKX
// We use Binance (most liquid, best data coverage)
const PAIRS: Record<string, string> = {
  OP: "OPUSDT_PERP.A",
  WIF: "WIFUSDT_PERP.A",
  ARB: "ARBUSDT_PERP.A",
  LDO: "LDOUSDT_PERP.A",
  TRUMP: "TRUMPUSDT_PERP.A",
  DASH: "DASHUSDT_PERP.A",
  DOT: "DOTUSDT_PERP.A",
  ENA: "ENAUSDT_PERP.A",
  DOGE: "DOGEUSDT_PERP.A",
  APT: "APTUSDT_PERP.A",
  LINK: "LINKUSDT_PERP.A",
  ADA: "ADAUSDT_PERP.A",
  WLD: "WLDUSDT_PERP.A",
  XRP: "XRPUSDT_PERP.A",
  UNI: "UNIUSDT_PERP.A",
  // BTC and ETH included for regime context
  BTC: "BTCUSDT_PERP.A",
  ETH: "ETHUSDT_PERP.A",
  SOL: "SOLUSDT_PERP.A",
  TIA: "TIAUSDT_PERP.A",
  // Additional pairs from research
  AVAX: "AVAXUSDT_PERP.A",
  NEAR: "NEARUSDT_PERP.A",
  ATOM: "ATOMUSDT_PERP.A",
  FTM: "FTMUSDT_PERP.A",
  MATIC: "MATICUSDT_PERP.A",
  INJ: "INJUSDT_PERP.A",
};

// ─── Types ──────────────────────────────────────────────────────────

interface OiBar {
  t: number; // timestamp (unix seconds)
  o: number; // open OI
  h: number; // high OI
  l: number; // low OI
  c: number; // close OI
}

interface FundingBar {
  t: number; // timestamp (unix seconds)
  o: number; // open rate
  h: number; // high rate
  l: number; // low rate
  c: number; // close rate
}

interface LiquidationBar {
  t: number; // timestamp (unix seconds)
  l: number; // long liquidations (USD)
  s: number; // short liquidations (USD)
}

interface LsRatioBar {
  t: number; // timestamp (unix seconds)
  r: number; // long/short ratio
  l: number; // long ratio (0-1)
  s: number; // short ratio (0-1)
}

interface CacheEntry<T> {
  symbol: string;
  interval: string;
  from: number;
  to: number;
  fetchedAt: number;
  data: T[];
}

// ─── Rate Limiter ───────────────────────────────────────────────────

let lastCallAt = 0;

async function rateLimitedFetch(url: string): Promise<unknown> {
  const now = Date.now();
  const elapsed = now - lastCallAt;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastCallAt = Date.now();

  const separator = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${separator}api_key=${API_KEY}`);

  if (res.status === 429) {
    console.log("[Coinalyze] Rate limited -- waiting 60s");
    await sleep(60_000);
    return rateLimitedFetch(url);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Cache Helpers ──────────────────────────────────────────────────

function cacheFile(pair: string, metric: string, interval: string): string {
  return path.join(CACHE_DIR, `${pair}_${metric}_${interval}.json`);
}

function loadCache<T>(pair: string, metric: string, interval: string): CacheEntry<T> | null {
  const fp = cacheFile(pair, metric, interval);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8")) as CacheEntry<T>;
  } catch {
    return null;
  }
}

function saveCache<T>(
  pair: string,
  metric: string,
  interval: string,
  symbol: string,
  data: T[],
): void {
  const entry: CacheEntry<T> = {
    symbol,
    interval,
    from: FROM_DATE,
    to: TO_DATE,
    fetchedAt: Math.floor(Date.now() / 1000),
    data,
  };
  fs.writeFileSync(cacheFile(pair, metric, interval), JSON.stringify(entry, null, 2));
}

function isCacheFresh(entry: CacheEntry<unknown>): boolean {
  // Re-fetch if cache is older than 24h
  const ageH = (Date.now() / 1000 - entry.fetchedAt) / 3600;
  return ageH < 24;
}

// ─── API Fetchers ────────────────────────────────────────────────────

async function fetchOiHistory(
  pair: string,
  symbol: string,
  interval: "daily" | "4hour",
): Promise<OiBar[]> {
  const cached = loadCache<OiBar>(pair, "oi", interval);
  if (cached && isCacheFresh(cached)) {
    console.log(`  [cache] ${pair} OI ${interval} (${cached.data.length} bars)`);
    return cached.data;
  }

  const url =
    `${BASE_URL}/open-interest-history` +
    `?symbols=${symbol}&interval=${interval}&from=${FROM_DATE}&to=${TO_DATE}`;

  console.log(`  [fetch] ${pair} OI ${interval}`);
  const raw = (await rateLimitedFetch(url)) as Array<{ symbol: string; history: OiBar[] }>;
  const data = raw[0]?.history ?? [];
  saveCache(pair, "oi", interval, symbol, data);
  return data;
}

async function fetchFundingHistory(pair: string, symbol: string): Promise<FundingBar[]> {
  // Funding rates settle every 8h on most exchanges
  const interval = "4hour";
  const cached = loadCache<FundingBar>(pair, "funding", interval);
  if (cached && isCacheFresh(cached)) {
    console.log(`  [cache] ${pair} funding ${interval} (${cached.data.length} bars)`);
    return cached.data;
  }

  const url =
    `${BASE_URL}/funding-rate-history` +
    `?symbols=${symbol}&interval=${interval}&from=${FROM_DATE}&to=${TO_DATE}`;

  console.log(`  [fetch] ${pair} funding ${interval}`);
  const raw = (await rateLimitedFetch(url)) as Array<{ symbol: string; history: FundingBar[] }>;
  const data = raw[0]?.history ?? [];
  saveCache(pair, "funding", interval, symbol, data);
  return data;
}

async function fetchLiquidationHistory(pair: string, symbol: string): Promise<LiquidationBar[]> {
  const interval = "daily";
  const cached = loadCache<LiquidationBar>(pair, "liq", interval);
  if (cached && isCacheFresh(cached)) {
    console.log(`  [cache] ${pair} liquidations ${interval} (${cached.data.length} bars)`);
    return cached.data;
  }

  const url =
    `${BASE_URL}/liquidation-history` +
    `?symbols=${symbol}&interval=${interval}&from=${FROM_DATE}&to=${TO_DATE}`;

  console.log(`  [fetch] ${pair} liquidations ${interval}`);
  const raw = (await rateLimitedFetch(url)) as Array<{
    symbol: string;
    history: LiquidationBar[];
  }>;
  const data = raw[0]?.history ?? [];
  saveCache(pair, "liq", interval, symbol, data);
  return data;
}

async function fetchLsRatioHistory(pair: string, symbol: string): Promise<LsRatioBar[]> {
  const interval = "daily";
  const cached = loadCache<LsRatioBar>(pair, "lsratio", interval);
  if (cached && isCacheFresh(cached)) {
    console.log(`  [cache] ${pair} L/S ratio ${interval} (${cached.data.length} bars)`);
    return cached.data;
  }

  const url =
    `${BASE_URL}/long-short-ratio-history` +
    `?symbols=${symbol}&interval=${interval}&from=${FROM_DATE}&to=${TO_DATE}`;

  console.log(`  [fetch] ${pair} L/S ratio ${interval}`);
  const raw = (await rateLimitedFetch(url)) as Array<{ symbol: string; history: LsRatioBar[] }>;
  const data = raw[0]?.history ?? [];
  saveCache(pair, "lsratio", interval, symbol, data);
  return data;
}

// ─── Validation ──────────────────────────────────────────────────────

function printSummary(
  pair: string,
  oiDaily: OiBar[],
  oi4h: OiBar[],
  funding: FundingBar[],
  liq: LiquidationBar[],
  lsratio: LsRatioBar[],
): void {
  const fmt = (n: number) => n.toString().padStart(5);
  const dateOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

  const firstDate = oiDaily[0] ? dateOf(oiDaily[0].t) : "n/a";
  const lastDate = oiDaily[oiDaily.length - 1] ? dateOf(oiDaily[oiDaily.length - 1]!.t) : "n/a";

  console.log(
    `  ${pair.padEnd(8)} ` +
      `OI-d:${fmt(oiDaily.length)} ` +
      `OI-4h:${fmt(oi4h.length)} ` +
      `FR:${fmt(funding.length)} ` +
      `Liq:${fmt(liq.length)} ` +
      `LS:${fmt(lsratio.length)} ` +
      `[${firstDate} .. ${lastDate}]`,
  );
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error(
      "[Coinalyze] COINALYZE_API_KEY not set.\n" +
        "Register at https://coinalyze.net/account/api-key/ (free, no credit card).\n" +
        "Then: export COINALYZE_API_KEY=your_key_here",
    );
    process.exit(1);
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`[Coinalyze] Cache dir: ${CACHE_DIR}`);
  console.log(
    `[Coinalyze] Collecting ${Object.keys(PAIRS).length} pairs from 2023-01-01 to present`,
  );
  console.log(`[Coinalyze] Rate limit: 1 call per ${RATE_LIMIT_MS}ms\n`);

  const results: Record<string, {
    oiDaily: OiBar[];
    oi4h: OiBar[];
    funding: FundingBar[];
    liq: LiquidationBar[];
    lsratio: LsRatioBar[];
  }> = {};

  let callCount = 0;
  const pairs = Object.entries(PAIRS);

  for (const [pair, symbol] of pairs) {
    console.log(`\n[${pair}] symbol=${symbol}`);

    try {
      // 4 endpoints * 2 intervals for OI = 5 API calls per pair
      const oiDaily = await fetchOiHistory(pair, symbol, "daily");
      callCount++;
      const oi4h = await fetchOiHistory(pair, symbol, "4hour");
      callCount++;
      const funding = await fetchFundingHistory(pair, symbol);
      callCount++;
      const liq = await fetchLiquidationHistory(pair, symbol);
      callCount++;
      const lsratio = await fetchLsRatioHistory(pair, symbol);
      callCount++;

      results[pair] = { oiDaily, oi4h, funding, liq, lsratio };
      printSummary(pair, oiDaily, oi4h, funding, liq, lsratio);
    } catch (err) {
      console.error(`  [ERROR] ${pair}: ${err instanceof Error ? err.message : String(err)}`);
      // Continue with remaining pairs
    }
  }

  // Save combined index for easy loading in backtests
  const indexPath = path.join(CACHE_DIR, "index.json");
  const index = {
    fetchedAt: new Date().toISOString(),
    from: "2023-01-01",
    to: new Date().toISOString().slice(0, 10),
    pairs: Object.fromEntries(
      Object.entries(results).map(([pair, d]) => [
        pair,
        {
          symbol: PAIRS[pair],
          oiDailyBars: d.oiDaily.length,
          oi4hBars: d.oi4h.length,
          fundingBars: d.funding.length,
          liqBars: d.liq.length,
          lsratioBars: d.lsratio.length,
        },
      ]),
    ),
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  console.log(`\n[Coinalyze] Done. ${callCount} API calls total.`);
  console.log(`[Coinalyze] Index written: ${indexPath}`);
  console.log(`\nTo load in a backtest script:`);
  console.log(
    `  import { loadCoinalyzeCache } from './collect-coinalyze-data' // or read JSON directly`,
  );
  console.log(`  const oiData = JSON.parse(fs.readFileSync('/tmp/coinalyze-cache/BTC_oi_daily.json', 'utf8'))`);
}

// ─── Export helpers for backtest scripts ─────────────────────────────

export function loadOiDaily(pair: string): OiBar[] {
  const cached = loadCache<OiBar>(pair, "oi", "daily");
  return cached?.data ?? [];
}

export function loadOi4h(pair: string): OiBar[] {
  const cached = loadCache<OiBar>(pair, "oi", "4hour");
  return cached?.data ?? [];
}

export function loadFunding(pair: string): FundingBar[] {
  const cached = loadCache<FundingBar>(pair, "funding", "4hour");
  return cached?.data ?? [];
}

export function loadLiquidations(pair: string): LiquidationBar[] {
  const cached = loadCache<LiquidationBar>(pair, "liq", "daily");
  return cached?.data ?? [];
}

export function loadLsRatio(pair: string): LsRatioBar[] {
  const cached = loadCache<LsRatioBar>(pair, "lsratio", "daily");
  return cached?.data ?? [];
}

// Export types for use in backtest scripts
export type { OiBar, FundingBar, LiquidationBar, LsRatioBar };

main().catch((err) => {
  console.error("[Coinalyze] Fatal:", err);
  process.exit(1);
});
