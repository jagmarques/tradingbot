/**
 * Comprehensive News vs GARCH v2 backtest.
 * Tests 4 strategy modes with parameter sweeps.
 *
 * Run: npx tsx scripts/backtest-news-vs-garch.ts
 */

import * as fs from "fs";
import * as path from "path";
import { ATR, ADX, EMA } from "technicalindicators";

// ---- Types ----

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }
interface NewsEvent { ts: number; direction: "long" | "short"; }
interface Position {
  key: string; // "{engine}-{pair}"
  pair: string;
  engine: "garch" | "news";
  direction: "long" | "short";
  entryPrice: number;
  entryTime: number;
  stopLoss: number;
  takeProfit: number;
  // stale exit tracking
  staleCheckTs: number; // timestamp when we check for stale
  staleClosed: boolean;
}
interface Trade {
  pair: string;
  engine: "garch" | "news";
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
}

// ---- Constants ----

const CACHE_DIR = "/tmp/bt-pair-cache";
const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;
const HL_FEE = 0.00035; // 0.035% taker (corrected)
const SIZE = 20;        // fixed $20 position
const LEVERAGE = 10;

const START_TS = new Date("2025-06-01T00:00:00Z").getTime();
const END_TS = new Date("2026-03-20T00:00:00Z").getTime();
const DAYS = (END_TS - START_TS) / DAY_MS; // ~293 days

// GARCH v2 params (from garch-chan-engine.ts)
const Z_LONG_THRESHOLD = 4.5;
const Z_SHORT_THRESHOLD = -3.0;
const GARCH_LOOKBACK = 3;
const GARCH_VOL_WINDOW = 20;
const ADX_LONG_MIN = 30;
const ADX_SHORT_MIN = 25;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const ATR_PERIOD = 14;
const VOL_FILTER_LOOKBACK = 5;
const VOL_FILTER_RATIO = 0.9;
const GARCH_SL = 0.03;
const GARCH_TP = 0.10;
const GARCH_MAX_HOLD = 48 * HOUR_MS;
const GARCH_MAX_PER_DIR = 6;

// All 20 GARCH pairs mapped to file names
const PAIR_MAP: Record<string, string> = {
  OP: "OPUSDT", ARB: "ARBUSDT", LDO: "LDOUSDT", TRUMP: "TRUMPUSDT",
  DOT: "DOTUSDT", ENA: "ENAUSDT", DOGE: "DOGEUSDT", APT: "APTUSDT",
  LINK: "LINKUSDT", ADA: "ADAUSDT", WLD: "WLDUSDT", XRP: "XRPUSDT",
  SOL: "SOLUSDT", BNB: "BNBUSDT", kSHIB: "kSHIBUSDT", TIA: "TIAUSDT",
  NEAR: "NEARUSDT", kBONK: "kBONKUSDT", ONDO: "ONDOUSDT", HYPE: "HYPEUSDT",
};
const ALL20 = Object.keys(PAIR_MAP);
const TOP10 = ["TIA", "kBONK", "OP", "LDO", "APT", "NEAR", "ARB", "ENA", "WLD", "ADA"];
const TOP5 = ["TIA", "kBONK", "OP", "LDO", "APT"];
const TOP15 = [...TOP10, "DOT", "ONDO", "LINK", "DOGE", "SOL"];

const SPREAD_MAP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, kSHIBUSDT: 1.85e-4,
  ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4,
  TRUMPUSDT: 3.65e-4, WLDUSDT: 4e-4,
  DOTUSDT: 4.95e-4, ADAUSDT: 5.55e-4,
  LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4,
  BTCUSDT: 0.5e-4, SOLUSDT: 1.5e-4,
  BNBUSDT: 1.2e-4, HYPEUSDT: 4e-4,
  TIAUSDT: 5e-4, NEARUSDT: 4.5e-4,
  kBONKUSDT: 5.5e-4, ONDOUSDT: 4.5e-4,
};

// ---- Data Loading ----

function loadCandles(filename: string): Candle[] {
  const fp = path.join(CACHE_DIR, filename + ".json");
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as unknown[];
  return (raw as (number[] | Candle)[]).map(b =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +(b[5] ?? 0) }
      : { ...b as Candle, v: (b as Candle).v ?? 0 }
  );
}

function getSpread(filename: string): number {
  return SPREAD_MAP[filename] ?? 4e-4;
}

// ---- News Event Detection ----
// FIX Issue 1: Tighter keyword list - removed generic terms that match
// non-crypto Trump posts (rate, tax, economy, shutdown, china, russia, etc.)
// Only keep terms directly tied to crypto markets or high-impact macro events

const CRYPTO_KEYWORDS = [
  "crypto", "bitcoin", "btc", "ethereum", "tariff", "trade war", "reserve",
  "defi", "blockchain", "digital asset", "stablecoin", "sec ", "cftc",
  "regulation", "ban crypto", "executive order", "digital currency",
  "strategic reserve", "national reserve",
];

function isCryptoRelevant(content: string): boolean {
  const lower = content.toLowerCase();
  return CRYPTO_KEYWORDS.some(kw => lower.includes(kw));
}

function loadNewsEvents(): NewsEvent[] {
  const fp = "/tmp/trump-full-archive.json";
  if (!fs.existsSync(fp)) {
    console.error("[News] Trump archive not found at", fp);
    return [];
  }
  const posts = JSON.parse(fs.readFileSync(fp, "utf8")) as Array<{ id: string; created_at: string; content: string }>;

  // Load BTC 1m candles for price confirmation
  const btc1mPath = "/tmp/btc-1m-candles.json";
  if (!fs.existsSync(btc1mPath)) {
    console.error("[News] BTC 1m candles not found");
    return [];
  }
  const btc1mRaw = JSON.parse(fs.readFileSync(btc1mPath, "utf8")) as number[][];
  // Sort by timestamp
  const btc1m = btc1mRaw.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }));
  btc1m.sort((a, b) => a.t - b.t);

  // Build sorted timestamp index for binary search
  const btcTs = btc1m.map(c => c.t);

  const events: NewsEvent[] = [];
  let relevantCount = 0;
  let bullishCount = 0;
  let bearishCount = 0;

  for (const post of posts) {
    if (!post.created_at || !post.content) continue;
    const postTs = new Date(post.created_at).getTime();
    if (isNaN(postTs)) continue;
    // Only test period
    if (postTs < START_TS || postTs > END_TS) continue;
    if (!isCryptoRelevant(post.content)) continue;
    relevantCount++;

    // Find BTC candles within 15 minutes of post
    const windowEnd = postTs + 15 * 60_000;

    // Binary search for first candle >= postTs
    let lo = 0, hi = btcTs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (btcTs[mid] < postTs) lo = mid + 1;
      else hi = mid;
    }

    // Get price at post time (closest candle at or before)
    const startIdx = Math.max(0, lo - 1);
    const startPrice = btc1m[startIdx]?.c ?? btc1m[lo]?.c;
    if (!startPrice) continue;

    // Check all candles within 15 minutes
    let maxUp = 0, maxDown = 0;
    for (let i = lo; i < btc1m.length && btc1m[i].t <= windowEnd; i++) {
      const move = (btc1m[i].c - startPrice) / startPrice;
      if (move > maxUp) maxUp = move;
      if (move < maxDown) maxDown = move;
    }

    // FIX Issue 1: When both up and down exceed threshold, take the
    // direction with the larger absolute move (not always bullish first)
    const THRESHOLD = 0.003; // 0.3%
    const upExceeds = maxUp > THRESHOLD;
    const downExceeds = Math.abs(maxDown) > THRESHOLD;

    if (upExceeds && downExceeds) {
      // Both exceed - take the larger absolute move
      if (maxUp >= Math.abs(maxDown)) {
        events.push({ ts: postTs, direction: "long" });
        bullishCount++;
      } else {
        events.push({ ts: postTs, direction: "short" });
        bearishCount++;
      }
    } else if (upExceeds) {
      events.push({ ts: postTs, direction: "long" });
      bullishCount++;
    } else if (downExceeds) {
      events.push({ ts: postTs, direction: "short" });
      bearishCount++;
    }
  }

  // Sort by time
  events.sort((a, b) => a.ts - b.ts);
  console.log(`[News] Scanned ${posts.filter(p => {
    const ts = new Date(p.created_at).getTime();
    return ts >= START_TS && ts <= END_TS;
  }).length} posts in period, ${relevantCount} crypto-relevant, found ${events.length} price-confirmed events (${bullishCount} BULLISH, ${bearishCount} BEARISH)`);
  return events;
}

// ---- All BTC-Move Event Detection ----

function loadAllBtcMoveEvents(): NewsEvent[] {
  const btc1mPath = "/tmp/btc-1m-candles.json";
  if (!fs.existsSync(btc1mPath)) {
    console.error("[AllEvents] BTC 1m candles not found at", btc1mPath);
    return [];
  }
  const btc1mRaw = JSON.parse(fs.readFileSync(btc1mPath, "utf8")) as number[][];
  const btc1m = btc1mRaw.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }));
  btc1m.sort((a, b) => a.t - b.t);

  const THRESHOLD = 0.003; // 0.3%
  const DEDUP_WINDOW = HOUR_MS; // 60 minutes

  const rawEvents: NewsEvent[] = [];

  // LOOK-AHEAD FIX: Look 15 bars BACKWARD from candle i.
  // At minute i, we check if BTC moved >0.3% in the PAST 15 minutes.
  // This is what we'd know in real-time: "BTC just moved 0.3%!"
  // Event timestamp = candle i (when we detect the move, not when it started).
  for (let i = 15; i < btc1m.length; i++) {
    const candle = btc1m[i];
    if (candle.t < START_TS || candle.t > END_TS) continue;

    const currentPrice = candle.c; // current price at detection time
    if (!currentPrice || currentPrice <= 0) continue;

    let maxUp = 0;
    let maxDown = 0;

    // Look 15 bars BACKWARD - what happened in the last 15 minutes
    const startPrice = btc1m[i - 15].o; // price 15 min ago
    if (!startPrice || startPrice <= 0) continue;

    for (let j = i - 15; j <= i; j++) {
      const up = (btc1m[j].h - startPrice) / startPrice;
      const down = (btc1m[j].l - startPrice) / startPrice;
      if (up > maxUp) maxUp = up;
      if (down < maxDown) maxDown = down;
    }

    const upExceeds = maxUp > THRESHOLD;
    const downExceeds = Math.abs(maxDown) > THRESHOLD;

    // Direction = which way BTC already moved (momentum continuation)
    if (upExceeds && downExceeds) {
      if (maxUp >= Math.abs(maxDown)) {
        rawEvents.push({ ts: candle.t, direction: "long" });
      } else {
        rawEvents.push({ ts: candle.t, direction: "short" });
      }
    } else if (upExceeds) {
      rawEvents.push({ ts: candle.t, direction: "long" });
    } else if (downExceeds) {
      rawEvents.push({ ts: candle.t, direction: "short" });
    }
  }

  // Sort by timestamp
  rawEvents.sort((a, b) => a.ts - b.ts);

  // Deduplicate: skip events within 60min of previous kept event
  const deduped: NewsEvent[] = [];
  let lastKeptTs = -Infinity;
  for (const evt of rawEvents) {
    if (evt.ts - lastKeptTs >= DEDUP_WINDOW) {
      deduped.push(evt);
      lastKeptTs = evt.ts;
    }
  }

  const longCount = deduped.filter(e => e.direction === "long").length;
  const shortCount = deduped.filter(e => e.direction === "short").length;
  console.log(`[AllEvents] Scanned ${btc1m.filter(c => c.t >= START_TS && c.t <= END_TS).length} candles, found ${rawEvents.length} raw events, ${deduped.length} after dedup (${longCount} long, ${shortCount} short)`);
  return deduped;
}

// ---- Precomputed Pair Data ----

interface PairData {
  candles: Candle[];
  tsMap: Map<number, number>;
  ema9: number[];
  ema21: number[];
  atr14: number[];
  adx14: Array<{ adx: number; pdi: number; mdi: number }>;
  zScores: number[]; // GARCH z-scores with lb=3 vw=20
}

function precomputePair(filename: string): PairData | null {
  const candles = loadCandles(filename);
  if (candles.length < 100) return null;

  const tsMap = new Map<number, number>();
  candles.forEach((c, i) => tsMap.set(c.t, i));

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);

  const ema9 = EMA.calculate({ period: EMA_FAST, values: closes });
  const ema21 = EMA.calculate({ period: EMA_SLOW, values: closes });
  const atr14 = ATR.calculate({ period: ATR_PERIOD, high: highs, low: lows, close: closes });
  const adx14 = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

  // Pre-compute GARCH z-scores
  const zScores = new Array(candles.length).fill(0);
  for (let i = Math.max(GARCH_LOOKBACK + 1, GARCH_VOL_WINDOW + 1); i < candles.length; i++) {
    const mom = candles[i].c / candles[i - GARCH_LOOKBACK].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - GARCH_VOL_WINDOW + 1); j <= i; j++) {
      const r = candles[j].c / candles[j - 1].c - 1;
      sumSq += r * r;
      count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    zScores[i] = mom / vol;
  }

  return { candles, tsMap, ema9, ema21, atr14, adx14, zScores };
}

function getVal(arr: number[], barIdx: number, candleLen: number): number | null {
  const offset = candleLen - arr.length;
  const idx = barIdx - offset;
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

function getAdxVal(
  arr: Array<{ adx: number; pdi: number; mdi: number }>,
  barIdx: number,
  candleLen: number
): { adx: number; pdi: number; mdi: number } | null {
  const offset = candleLen - arr.length;
  const idx = barIdx - offset;
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

// ---- GARCH v2 Signal ----

function garchSignal(
  pd: PairData,
  barIdx: number,
  btcPd: PairData,
  btcTsToIdx: Map<number, number>,
  pairTs: number
): "long" | "short" | null {
  const prev = barIdx - 1; // look-ahead bias fix
  if (prev < GARCH_VOL_WINDOW + GARCH_LOOKBACK) return null;

  const z = pd.zScores[prev];
  if (isNaN(z) || z === 0) return null;

  const goLong = z > Z_LONG_THRESHOLD;
  const goShort = z < Z_SHORT_THRESHOLD;
  if (!goLong && !goShort) return null;

  // ADX filter
  const adx = getAdxVal(pd.adx14, prev, pd.candles.length);
  if (!adx) return null;
  if (goLong && adx.adx < ADX_LONG_MIN) return null;
  if (goShort && adx.adx < ADX_SHORT_MIN) return null;

  // EMA 9/21 pair trend
  const ema9 = getVal(pd.ema9, prev, pd.candles.length);
  const ema21 = getVal(pd.ema21, prev, pd.candles.length);
  if (ema9 === null || ema21 === null) return null;
  if (goLong && ema9 <= ema21) return null;
  if (goShort && ema9 >= ema21) return null;

  // BTC trend - find BTC bar matching this timestamp
  const btcBarIdx = btcTsToIdx.get(pairTs);
  if (btcBarIdx === undefined || btcBarIdx < 1) return null;
  const btcPrev = btcBarIdx - 1;
  const btcEma9 = getVal(btcPd.ema9, btcPrev, btcPd.candles.length);
  const btcEma21 = getVal(btcPd.ema21, btcPrev, btcPd.candles.length);
  if (btcEma9 === null || btcEma21 === null) return null;
  const btcTrend = btcEma9 > btcEma21 ? "long" : "short";
  if (goLong && btcTrend !== "long") return null;
  if (goShort && btcTrend !== "short") return null;

  // Vol filter: ATR must not be declining
  const atrNow = getVal(pd.atr14, prev, pd.candles.length);
  const atrOld = getVal(pd.atr14, prev - VOL_FILTER_LOOKBACK, pd.candles.length);
  if (atrNow === null || atrOld === null) return null;
  if (atrNow < VOL_FILTER_RATIO * atrOld) return null;

  return goLong ? "long" : "short";
}

// ---- Stats Computation ----

interface Stats {
  name: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  perDay: number;
  maxDd: number;
  sharpe: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  fees: number;
  annRet: number;
}

// FIX Issue 4: computeStats now takes mark-to-market equity curve
// (includes unrealized P&L at each bar, not just realized)
function computeStats(name: string, trades: Trade[], equityCurve: number[]): Stats {
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;

  // MaxDD from mark-to-market equity curve
  let maxDd = 0, peak = -Infinity;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDd) maxDd = dd;
  }

  const dailyPnlMap = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.exitTime / DAY_MS);
    dailyPnlMap.set(day, (dailyPnlMap.get(day) ?? 0) + t.pnl);
  }
  const dr = Array.from(dailyPnlMap.values());
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  const winRate = trades.length > 0 ? (wins / trades.length * 100) : 0;
  const perDay = totalPnl / DAYS;
  const winTrades = trades.filter(t => t.pnl > 0);
  const lossTrades = trades.filter(t => t.pnl <= 0);
  const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length : 0;
  const profitFactor = lossTrades.length > 0 && avgLoss !== 0
    ? Math.abs((avgWin * winTrades.length) / (avgLoss * lossTrades.length))
    : 0;
  const fees = trades.length * SIZE * LEVERAGE * HL_FEE * 2;

  // Annual return as % of $400 proxy capital
  const annRet = (totalPnl / DAYS * 365) / 400 * 100;

  return { name, trades: trades.length, wins, winRate, totalPnl, perDay, maxDd, sharpe, profitFactor, avgWin, avgLoss, fees, annRet };
}

// ---- Simulation Engine ----

interface NewsConfig {
  tp: number;
  sl: number;
  maxHoldMs: number;
  staleCheckMs: number;   // 0 = no stale exit
  staleMinMove: number;   // minimum move in direction to not be stale
  pairs: string[];
}

interface SimConfig {
  name: string;
  runGarch: boolean;
  runNews: boolean;
  newsConfig?: NewsConfig;
  garchDefense: boolean; // close GARCH positions in hurt direction on news event
  garchCooldown: boolean; // 30min cooldown after news event
  sharedCap: boolean;     // if true: max 6/dir total across both engines
}

function simulate(
  cfg: SimConfig,
  pairDataMap: Map<string, PairData>,
  btcPd: PairData,
  newsEvents: NewsEvent[]
): { trades: Trade[]; equityCurve: number[] } {
  // Build sorted hourly timestamps for the test period
  const allTimestamps = new Set<number>();
  for (const [, pd] of pairDataMap) {
    for (const c of pd.candles) {
      if (c.t >= START_TS && c.t < END_TS) allTimestamps.add(c.t);
    }
  }
  const sortedTs = [...allTimestamps].sort((a, b) => a - b);

  // BTC timestamp -> index map
  const btcTsToIdx = new Map<number, number>();
  btcPd.candles.forEach((c, i) => btcTsToIdx.set(c.t, i));

  const openPositions = new Map<string, Position>();
  const trades: Trade[] = [];
  const equityCurve: number[] = [];
  let cumulativePnl = 0;

  // Cooldown tracking per direction
  const cooldownUntil = { long: 0, short: 0 };

  // Pre-sort news events for quick lookup
  const sortedNews = [...newsEvents].sort((a, b) => a.ts - b.ts);

  // Pair name (short) -> filename
  const pairToFile = new Map<string, string>();
  for (const [pair, file] of Object.entries(PAIR_MAP)) {
    pairToFile.set(pair, file);
  }

  for (const ts of sortedTs) {
    const closedThisBar = new Set<string>();

    // LOOK-AHEAD FIX: Check for events in the PREVIOUS hour [ts - HOUR_MS, ts).
    // Event detected at minute X -> we can only act on the NEXT hourly bar open.
    // This is realistic: BTC moved, we detect it, we enter at next bar open.
    // For Trump events: post at 14:05, BTC moves by 14:20, we detect at 14:20,
    // we enter at 15:00 bar open. ~40 min delay with 1h bars.
    const newsInWindow = sortedNews.filter(e => e.ts >= ts - HOUR_MS && e.ts < ts);

    // --- EXITS ---
    for (const [posKey, pos] of openPositions) {
      const filename = pairToFile.get(pos.pair);
      if (!filename) continue;
      const pd = pairDataMap.get(filename);
      if (!pd) continue;
      const barIdx = pd.tsMap.get(ts) ?? -1;
      if (barIdx < 0) continue;
      const bar = pd.candles[barIdx];
      const spread = getSpread(filename);

      // Defense: close GARCH positions in hurt direction on news event
      if (cfg.garchDefense && pos.engine === "garch" && newsInWindow.length > 0) {
        for (const evt of newsInWindow) {
          const hurtDir = evt.direction === "long" ? "short" : "long";
          if (pos.direction === hurtDir) {
            const exitPrice = pos.direction === "long"
              ? bar.o * (1 - spread)
              : bar.o * (1 + spread);
            const fees = SIZE * LEVERAGE * HL_FEE * 2;
            const rawPnl = pos.direction === "long"
              ? (exitPrice / pos.entryPrice - 1) * SIZE * LEVERAGE
              : (pos.entryPrice / exitPrice - 1) * SIZE * LEVERAGE;
            const pnl = rawPnl - fees;
            trades.push({ pair: pos.pair, engine: pos.engine, direction: pos.direction, entryPrice: pos.entryPrice, exitPrice, entryTime: pos.entryTime, exitTime: ts, pnl, reason: "news-defense" });
            cumulativePnl += pnl;
            openPositions.delete(posKey);
            closedThisBar.add(posKey);
            break;
          }
        }
        if (closedThisBar.has(posKey)) continue;
      }

      let exitPrice = 0, reason = "";

      // SL check
      const slHit = pos.direction === "long" ? bar.l <= pos.stopLoss : bar.h >= pos.stopLoss;
      if (slHit) {
        exitPrice = pos.direction === "long"
          ? pos.stopLoss * (1 - spread)
          : pos.stopLoss * (1 + spread);
        reason = "stop-loss";
      }

      // TP check
      if (!reason && pos.takeProfit > 0) {
        const tpHit = pos.direction === "long" ? bar.h >= pos.takeProfit : bar.l <= pos.takeProfit;
        if (tpHit) {
          exitPrice = pos.direction === "long"
            ? pos.takeProfit * (1 - spread)
            : pos.takeProfit * (1 + spread);
          reason = "take-profit";
        }
      }

      // FIX Issue 3: Stale exit uses hourly granularity
      // Since we use 1h bars, 30min stale can't fire until the next bar (1h later)
      // So minimum granularity is 1 bar = 1h. The staleCheckMs still works
      // but we document that with 1h data, staleCheckMs < HOUR_MS effectively
      // rounds up to 1h (first bar check)
      if (!reason && pos.engine === "news" && cfg.newsConfig && cfg.newsConfig.staleCheckMs > 0) {
        if (ts >= pos.staleCheckTs && !pos.staleClosed) {
          // Check if moved in our direction
          const movePct = pos.direction === "long"
            ? (bar.c - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - bar.c) / pos.entryPrice;
          if (movePct < cfg.newsConfig.staleMinMove) {
            exitPrice = pos.direction === "long" ? bar.o * (1 - spread) : bar.o * (1 + spread);
            reason = "stale-exit";
          }
        }
      }

      // Max hold
      if (!reason) {
        const maxHold = pos.engine === "garch" ? GARCH_MAX_HOLD : (cfg.newsConfig?.maxHoldMs ?? GARCH_MAX_HOLD);
        if (ts - pos.entryTime >= maxHold) {
          exitPrice = pos.direction === "long" ? bar.o * (1 - spread) : bar.o * (1 + spread);
          reason = "max-hold";
        }
      }

      if (reason) {
        const fees = SIZE * LEVERAGE * HL_FEE * 2;
        const rawPnl = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * SIZE * LEVERAGE
          : (pos.entryPrice / exitPrice - 1) * SIZE * LEVERAGE;
        const pnl = rawPnl - fees;
        trades.push({ pair: pos.pair, engine: pos.engine, direction: pos.direction, entryPrice: pos.entryPrice, exitPrice, entryTime: pos.entryTime, exitTime: ts, pnl, reason });
        cumulativePnl += pnl;
        openPositions.delete(posKey);
        closedThisBar.add(posKey);
      }
    }

    // Update cooldown based on news events
    if (cfg.garchCooldown && newsInWindow.length > 0) {
      for (const evt of newsInWindow) {
        const hurtDir = evt.direction === "long" ? "short" : "long";
        cooldownUntil[hurtDir] = Math.max(cooldownUntil[hurtDir], ts + 30 * 60_000);
      }
    }

    // --- ENTRIES ---

    // GARCH entries
    if (cfg.runGarch) {
      for (const [shortPair, filename] of pairToFile) {
        const posKey = `garch-${shortPair}`;
        if (openPositions.has(posKey) || closedThisBar.has(posKey)) continue;

        const pd = pairDataMap.get(filename);
        if (!pd) continue;
        const barIdx = pd.tsMap.get(ts) ?? -1;
        if (barIdx < 50) continue;

        const dir = garchSignal(pd, barIdx, btcPd, btcTsToIdx, ts);
        if (!dir) continue;

        // Cooldown check
        if (cfg.garchCooldown && ts < cooldownUntil[dir]) continue;

        // Position count check
        const garchPositions = [...openPositions.values()].filter(p => p.engine === "garch");
        const dirCount = cfg.sharedCap
          ? [...openPositions.values()].filter(p => p.direction === dir).length
          : garchPositions.filter(p => p.direction === dir).length;
        if (dirCount >= GARCH_MAX_PER_DIR) continue;

        const bar = pd.candles[barIdx];
        const spread = getSpread(filename);
        const entryPrice = dir === "long" ? bar.o * (1 + spread) : bar.o * (1 - spread);
        const stopLoss = dir === "long" ? entryPrice * (1 - GARCH_SL) : entryPrice * (1 + GARCH_SL);
        const takeProfit = dir === "long" ? entryPrice * (1 + GARCH_TP) : entryPrice * (1 - GARCH_TP);

        openPositions.set(posKey, {
          key: posKey, pair: shortPair, engine: "garch", direction: dir,
          entryPrice, entryTime: ts, stopLoss, takeProfit,
          staleCheckTs: ts + GARCH_MAX_HOLD, staleClosed: false,
        });
      }
    }

    // News entries
    if (cfg.runNews && cfg.newsConfig && newsInWindow.length > 0) {
      const nc = cfg.newsConfig;
      // Pick the first (or most recent) event in the window
      const evt = newsInWindow[newsInWindow.length - 1];
      const dir = evt.direction;

      for (const shortPair of nc.pairs) {
        const posKey = `news-${shortPair}`;
        if (openPositions.has(posKey) || closedThisBar.has(posKey)) continue;

        const filename = pairToFile.get(shortPair);
        if (!filename) continue;
        const pd = pairDataMap.get(filename);
        if (!pd) continue;
        const barIdx = pd.tsMap.get(ts) ?? -1;
        if (barIdx < 10) continue;

        // Position cap
        const newsPositions = [...openPositions.values()].filter(p => p.engine === "news");
        const dirCount = cfg.sharedCap
          ? [...openPositions.values()].filter(p => p.direction === dir).length
          : newsPositions.filter(p => p.direction === dir).length;
        if (dirCount >= GARCH_MAX_PER_DIR) continue;

        const bar = pd.candles[barIdx];
        const spread = getSpread(filename);
        const entryPrice = dir === "long" ? bar.o * (1 + spread) : bar.o * (1 - spread);
        const stopLoss = dir === "long" ? entryPrice * (1 - nc.sl) : entryPrice * (1 + nc.sl);
        const takeProfit = dir === "long" ? entryPrice * (1 + nc.tp) : entryPrice * (1 - nc.tp);
        const staleCheckTs = nc.staleCheckMs > 0 ? ts + nc.staleCheckMs : Infinity;

        openPositions.set(posKey, {
          key: posKey, pair: shortPair, engine: "news", direction: dir,
          entryPrice, entryTime: ts, stopLoss, takeProfit,
          staleCheckTs, staleClosed: false,
        });
      }
    }

    // FIX Issue 4: Mark-to-market equity curve
    // At each bar, compute: cumulativeRealizedPnl + sum(unrealized P&L of open positions)
    let unrealizedPnl = 0;
    for (const [, pos] of openPositions) {
      const filename = pairToFile.get(pos.pair);
      if (!filename) continue;
      const pd = pairDataMap.get(filename);
      if (!pd) continue;
      const barIdx = pd.tsMap.get(ts) ?? -1;
      if (barIdx < 0) continue;
      const bar = pd.candles[barIdx];
      const spread = getSpread(filename);

      // Compute unrealized P&L at this bar's close (using mid-price approximation)
      const markPrice = bar.c;
      const rawUnrealized = pos.direction === "long"
        ? (markPrice / pos.entryPrice - 1) * SIZE * LEVERAGE
        : (pos.entryPrice / markPrice - 1) * SIZE * LEVERAGE;
      // Subtract estimated exit fees (entry fees already "paid")
      unrealizedPnl += rawUnrealized - SIZE * LEVERAGE * HL_FEE;
    }
    equityCurve.push(cumulativePnl + unrealizedPnl);
  }

  return { trades, equityCurve };
}

// ---- Table Formatting ----

function pad(s: string | number, n: number, right = false): string {
  const str = typeof s === "number" ? (Number.isInteger(s) ? s.toString() : s.toFixed(1)) : s;
  return right ? str.padStart(n) : str.padEnd(n);
}

function fmtRow(s: Stats): string {
  const wr = `${s.winRate.toFixed(0)}%`;
  const pnl = `$${s.totalPnl.toFixed(0)}`;
  const pd = `$${s.perDay.toFixed(2)}`;
  const dd = `$${s.maxDd.toFixed(0)}`;
  const sh = s.sharpe.toFixed(2);
  const pf = s.profitFactor.toFixed(2);
  const aw = `$${s.avgWin.toFixed(2)}`;
  const al = `$${s.avgLoss.toFixed(2)}`;
  const fe = `$${s.fees.toFixed(0)}`;
  const ar = `${s.annRet.toFixed(0)}%`;
  return `${pad(s.name, 36)} | ${pad(s.trades, 6, true)} | ${pad(wr, 5, true)} | ${pad(pnl, 7, true)} | ${pad(pd, 7, true)} | ${pad(dd, 6, true)} | ${pad(sh, 6, true)} | ${pad(pf, 5, true)} | ${pad(aw, 7, true)} | ${pad(al, 8, true)} | ${pad(fe, 6, true)} | ${pad(ar, 7, true)}`;
}

function printHeader(): void {
  console.log(`${pad("Strategy", 36)} | ${pad("Trades", 6, true)} | ${pad("WR%", 5, true)} | ${pad("PnL", 7, true)} | ${pad("$/day", 7, true)} | ${pad("MaxDD", 6, true)} | ${pad("Sharpe", 6, true)} | ${pad("PF", 5, true)} | ${pad("AvgW", 7, true)} | ${pad("AvgL", 8, true)} | ${pad("Fees", 6, true)} | ${pad("AnnRet", 7, true)}`);
  console.log("-".repeat(130));
}

// ---- Main ----

async function main() {
  // Capture all console output for file saving
  const outputLines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(a => String(a)).join(" ");
    outputLines.push(line);
    origLog(...args);
  };

  console.log("=== All-Sources News vs GARCH v2 Backtest (Task 335) ===");
  console.log(`Period: 2025-06-01 to 2026-03-20 (${DAYS.toFixed(0)} days)`);
  console.log("Loading data...\n");

  // Load all pair data
  const pairDataMap = new Map<string, PairData>();
  for (const filename of Object.values(PAIR_MAP)) {
    const pd = precomputePair(filename);
    if (pd) {
      pairDataMap.set(filename, pd);
    } else {
      console.warn(`[Warn] No data for ${filename}`);
    }
  }

  // Load BTC 1h data
  const btcPd = precomputePair("BTCUSDT");
  if (!btcPd) {
    console.error("Failed to load BTC 1h data");
    process.exit(1);
  }
  pairDataMap.set("BTCUSDT", btcPd);

  console.log(`Loaded ${pairDataMap.size - 1} altcoin pairs + BTC 1h`);

  // Load both event sources
  const trumpEvents = loadNewsEvents();
  const allBtcEvents = loadAllBtcMoveEvents();

  // Compute overlap: Trump events within 30min of an AllEvents event
  let overlapCount = 0;
  for (const te of trumpEvents) {
    const hasMatch = allBtcEvents.some(ae => Math.abs(ae.ts - te.ts) <= 30 * 60_000);
    if (hasMatch) overlapCount++;
  }
  console.log(`\nEvent sources: Trump-only: ${trumpEvents.length} | All BTC moves: ${allBtcEvents.length} | Overlap: ${overlapCount} (${trumpEvents.length > 0 ? ((overlapCount / trumpEvents.length) * 100).toFixed(0) : 0}% of Trump events)`);

  console.log(`\nRunning simulations...\n`);

  // Helper to run a config with specific events
  function runWith(cfg: SimConfig, events: NewsEvent[]): Stats {
    const { trades, equityCurve } = simulate(cfg, pairDataMap, btcPd, events);
    return computeStats(cfg.name, trades, equityCurve);
  }

  // ==============================
  // PHASE A: Trump-only (baseline from 334)
  // ==============================
  console.log("--- Phase A: Trump-only baseline ---");

  const allTrumpResults: Stats[] = [];

  // GARCH baselines (no events needed)
  const garchBaseline = runWith({
    name: "GARCH-v2-baseline",
    runGarch: true, runNews: false,
    garchDefense: false, garchCooldown: false, sharedCap: false,
  }, trumpEvents);
  allTrumpResults.push(garchBaseline);

  const garchDefense = runWith({
    name: "GARCH+defense(trump)",
    runGarch: true, runNews: false,
    garchDefense: true, garchCooldown: true, sharedCap: false,
  }, trumpEvents);
  allTrumpResults.push(garchDefense);

  // Trump pair set sweep
  const pairSets = [
    { name: "all20", pairs: ALL20 },
    { name: "top15", pairs: TOP15 },
    { name: "top10", pairs: TOP10 },
    { name: "top5", pairs: TOP5 },
  ];
  const trumpPairSetResults: Stats[] = [];
  for (const ps of pairSets) {
    const s = runWith({
      name: `Trump-${ps.name}-TP5-SL2-h4-s1h`,
      runGarch: false, runNews: true,
      newsConfig: { tp: 0.05, sl: 0.02, maxHoldMs: 4 * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.005, pairs: ps.pairs },
      garchDefense: false, garchCooldown: false, sharedCap: false,
    }, trumpEvents);
    trumpPairSetResults.push(s);
    allTrumpResults.push(s);
  }

  // Trump TP/SL grid
  const tpValues = [0.03, 0.05, 0.07, 0.10];
  const slValues = [0.01, 0.015, 0.02, 0.03];
  const trumpTpSlResults: Stats[] = [];
  for (const tp of tpValues) {
    for (const sl of slValues) {
      const slLabel = sl === 0.015 ? "1.5" : (sl * 100).toFixed(0);
      const s = runWith({
        name: `Trump-top10-TP${(tp * 100).toFixed(0)}-SL${slLabel}-h4-s1h`,
        runGarch: false, runNews: true,
        newsConfig: { tp, sl, maxHoldMs: 4 * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.005, pairs: TOP10 },
        garchDefense: false, garchCooldown: false, sharedCap: false,
      }, trumpEvents);
      trumpTpSlResults.push(s);
      allTrumpResults.push(s);
    }
  }

  // Trump stale sweep
  const staleConfigs = [
    { name: "no-stale", staleCheckMs: 0, staleMinMove: 0 },
    { name: "s1h@0.3%", staleCheckMs: HOUR_MS, staleMinMove: 0.003 },
    { name: "s1h@0.5%", staleCheckMs: HOUR_MS, staleMinMove: 0.005 },
    { name: "s1h@1%", staleCheckMs: HOUR_MS, staleMinMove: 0.01 },
    { name: "s2h@0.5%", staleCheckMs: 2 * HOUR_MS, staleMinMove: 0.005 },
  ];
  const trumpStaleResults: Stats[] = [];
  for (const sc of staleConfigs) {
    const s = runWith({
      name: `Trump-top10-TP5-SL2-h4-${sc.name}`,
      runGarch: false, runNews: true,
      newsConfig: { tp: 0.05, sl: 0.02, maxHoldMs: 4 * HOUR_MS, staleCheckMs: sc.staleCheckMs, staleMinMove: sc.staleMinMove, pairs: TOP10 },
      garchDefense: false, garchCooldown: false, sharedCap: false,
    }, trumpEvents);
    trumpStaleResults.push(s);
    allTrumpResults.push(s);
  }

  // Trump hold sweep
  const holdConfigs = [2, 4, 6, 8, 12];
  const trumpHoldResults: Stats[] = [];
  for (const h of holdConfigs) {
    const s = runWith({
      name: `Trump-top10-TP5-SL2-h${h}-s1h`,
      runGarch: false, runNews: true,
      newsConfig: { tp: 0.05, sl: 0.02, maxHoldMs: h * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.005, pairs: TOP10 },
      garchDefense: false, garchCooldown: false, sharedCap: false,
    }, trumpEvents);
    trumpHoldResults.push(s);
    allTrumpResults.push(s);
  }

  // Trump best configs for head-to-head: TP10/SL3 and TP5/SL2
  const trumpTP10SL3 = runWith({
    name: "Trump-top10-TP10-SL3-h4to8-s1h@0.3",
    runGarch: false, runNews: true,
    newsConfig: { tp: 0.10, sl: 0.03, maxHoldMs: 8 * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.003, pairs: TOP10 },
    garchDefense: false, garchCooldown: false, sharedCap: false,
  }, trumpEvents);

  const trumpTP5SL2 = runWith({
    name: "Trump-top10-TP5-SL2-h4-s1h@0.5",
    runGarch: false, runNews: true,
    newsConfig: { tp: 0.05, sl: 0.02, maxHoldMs: 4 * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.005, pairs: TOP10 },
    garchDefense: false, garchCooldown: false, sharedCap: false,
  }, trumpEvents);

  // Trump combined configs
  const trumpBestNewsConfig: NewsConfig = {
    tp: 0.05, sl: 0.02, maxHoldMs: 4 * HOUR_MS,
    staleCheckMs: HOUR_MS, staleMinMove: 0.005,
    pairs: ALL20,
  };

  const trumpCombinedNoDefense = runWith({
    name: "GARCH+Trump-no-defense",
    runGarch: true, runNews: true,
    newsConfig: trumpBestNewsConfig,
    garchDefense: false, garchCooldown: false, sharedCap: false,
  }, trumpEvents);
  allTrumpResults.push(trumpCombinedNoDefense);

  const trumpCombinedWithDefense = runWith({
    name: "GARCH+Trump-with-defense",
    runGarch: true, runNews: true,
    newsConfig: trumpBestNewsConfig,
    garchDefense: true, garchCooldown: true, sharedCap: false,
  }, trumpEvents);
  allTrumpResults.push(trumpCombinedWithDefense);

  // Per-pair Trump analysis
  const trumpPerPairStats: Stats[] = [];
  const { trades: trumpBestTrades } = simulate({
    name: "trump-best-all20",
    runGarch: false, runNews: true,
    newsConfig: trumpBestNewsConfig,
    garchDefense: false, garchCooldown: false, sharedCap: false,
  }, pairDataMap, btcPd, trumpEvents);

  for (const shortPair of ALL20) {
    const pairTrades = trumpBestTrades.filter(t => t.pair === shortPair);
    if (pairTrades.length === 0) continue;
    let maxDd = 0, peak2 = -Infinity, cum = 0;
    for (const t of pairTrades) {
      cum += t.pnl;
      if (cum > peak2) peak2 = cum;
      const dd = peak2 - cum;
      if (dd > maxDd) maxDd = dd;
    }
    const wins = pairTrades.filter(t => t.pnl > 0).length;
    const winTrades = pairTrades.filter(t => t.pnl > 0);
    const lossTrades = pairTrades.filter(t => t.pnl <= 0);
    const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length : 0;
    const avgLoss = lossTrades.length > 0 ? lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length : 0;
    const profitFactor = lossTrades.length > 0 && avgLoss !== 0
      ? Math.abs((avgWin * winTrades.length) / (avgLoss * lossTrades.length))
      : 0;
    const totalPnl = pairTrades.reduce((s, t) => s + t.pnl, 0);
    trumpPerPairStats.push({
      name: shortPair,
      trades: pairTrades.length,
      wins,
      winRate: pairTrades.length > 0 ? wins / pairTrades.length * 100 : 0,
      totalPnl,
      perDay: totalPnl / DAYS,
      maxDd,
      sharpe: 0,
      profitFactor,
      avgWin,
      avgLoss,
      fees: pairTrades.length * SIZE * LEVERAGE * HL_FEE * 2,
      annRet: (totalPnl / DAYS * 365) / 400 * 100,
    });
  }
  trumpPerPairStats.sort((a, b) => b.perDay - a.perDay);

  // ==============================
  // PHASE B: All BTC-move events
  // ==============================
  console.log("--- Phase B: All BTC-move events ---");

  const allEvtResults: Stats[] = [];

  // Same two configs as Phase A head-to-head
  const allEvtTP10SL3 = runWith({
    name: "AllEvt-top10-TP10-SL3-h4to8-s1h@0.3",
    runGarch: false, runNews: true,
    newsConfig: { tp: 0.10, sl: 0.03, maxHoldMs: 8 * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.003, pairs: TOP10 },
    garchDefense: false, garchCooldown: false, sharedCap: false,
  }, allBtcEvents);
  allEvtResults.push(allEvtTP10SL3);

  const allEvtTP5SL2 = runWith({
    name: "AllEvt-top10-TP5-SL2-h4-s1h@0.5",
    runGarch: false, runNews: true,
    newsConfig: { tp: 0.05, sl: 0.02, maxHoldMs: 4 * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.005, pairs: TOP10 },
    garchDefense: false, garchCooldown: false, sharedCap: false,
  }, allBtcEvents);
  allEvtResults.push(allEvtTP5SL2);

  // AllEvt TP/SL sweep
  const allEvtTpSlResults: Stats[] = [];
  for (const tp of [0.03, 0.05, 0.07, 0.10]) {
    for (const sl of [0.01, 0.02, 0.03]) {
      const s = runWith({
        name: `AllEvt-top10-TP${(tp * 100).toFixed(0)}-SL${(sl * 100).toFixed(0)}-h4-s1h`,
        runGarch: false, runNews: true,
        newsConfig: { tp, sl, maxHoldMs: 4 * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.005, pairs: TOP10 },
        garchDefense: false, garchCooldown: false, sharedCap: false,
      }, allBtcEvents);
      allEvtTpSlResults.push(s);
      allEvtResults.push(s);
    }
  }

  // Find best TP/SL for AllEvt
  const bestAllEvtTpSl = [...allEvtTpSlResults].sort((a, b) => b.perDay - a.perDay)[0];

  // AllEvt stale sweep using best TP/SL
  const bestTpMatch = allEvtTpSlResults.indexOf(bestAllEvtTpSl);
  const bestTpVal = [0.03, 0.05, 0.07, 0.10][Math.floor(bestTpMatch / 3)];
  const bestSlVal = [0.01, 0.02, 0.03][bestTpMatch % 3];

  const allEvtStaleResults: Stats[] = [];
  for (const sc of [
    { name: "no-stale", staleCheckMs: 0, staleMinMove: 0 },
    { name: "s1h@0.3%", staleCheckMs: HOUR_MS, staleMinMove: 0.003 },
    { name: "s1h@0.5%", staleCheckMs: HOUR_MS, staleMinMove: 0.005 },
    { name: "s2h@0.5%", staleCheckMs: 2 * HOUR_MS, staleMinMove: 0.005 },
  ]) {
    const s = runWith({
      name: `AllEvt-top10-TP${(bestTpVal * 100).toFixed(0)}-SL${(bestSlVal * 100).toFixed(0)}-h4-${sc.name}`,
      runGarch: false, runNews: true,
      newsConfig: { tp: bestTpVal, sl: bestSlVal, maxHoldMs: 4 * HOUR_MS, staleCheckMs: sc.staleCheckMs, staleMinMove: sc.staleMinMove, pairs: TOP10 },
      garchDefense: false, garchCooldown: false, sharedCap: false,
    }, allBtcEvents);
    allEvtStaleResults.push(s);
    allEvtResults.push(s);
  }

  // AllEvt pair set sweep with best TP/SL
  const allEvtPairSetResults: Stats[] = [];
  for (const ps of pairSets) {
    const s = runWith({
      name: `AllEvt-${ps.name}-TP${(bestTpVal * 100).toFixed(0)}-SL${(bestSlVal * 100).toFixed(0)}`,
      runGarch: false, runNews: true,
      newsConfig: { tp: bestTpVal, sl: bestSlVal, maxHoldMs: 4 * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.005, pairs: ps.pairs },
      garchDefense: false, garchCooldown: false, sharedCap: false,
    }, allBtcEvents);
    allEvtPairSetResults.push(s);
    allEvtResults.push(s);
  }

  // ==============================
  // PHASE C: Combined GARCH + all-events
  // ==============================
  console.log("--- Phase C: GARCH + All-events combined ---");

  const allEvtBestConfig: NewsConfig = {
    tp: bestTpVal, sl: bestSlVal, maxHoldMs: 4 * HOUR_MS,
    staleCheckMs: HOUR_MS, staleMinMove: 0.005,
    pairs: TOP10,
  };

  const allEvtCombinedNoDefense = runWith({
    name: "GARCH+AllEvt-no-defense",
    runGarch: true, runNews: true,
    newsConfig: allEvtBestConfig,
    garchDefense: false, garchCooldown: false, sharedCap: false,
  }, allBtcEvents);

  const allEvtCombinedWithDefense = runWith({
    name: "GARCH+AllEvt-with-defense",
    runGarch: true, runNews: true,
    newsConfig: allEvtBestConfig,
    garchDefense: true, garchCooldown: true, sharedCap: false,
  }, allBtcEvents);

  // ==============================
  // OUTPUT: Trump-only sections (preserved from 334)
  // ==============================
  console.log("\n\n=== PHASE A: TRUMP-ONLY RESULTS ===\n");

  console.log("=== TRUMP STRATEGY COMPARISON === (sorted by $/day desc)");
  printHeader();
  const sortedTrump = [...allTrumpResults].sort((a, b) => b.perDay - a.perDay);
  for (const s of sortedTrump) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== TRUMP PAIR SET COMPARISON ===");
  printHeader();
  for (const s of trumpPairSetResults) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== TRUMP TP/SL GRID === (top10 pairs, hold4h, stale1h@0.5%)");
  const slFmt = (sl: number) => sl === 0.015 ? "1.5" : (sl * 100).toFixed(0);
  const tpFmt = (tp: number) => (tp * 100).toFixed(0);
  const slHeaders = slValues.map(sl => `SL${slFmt(sl)}%`.padStart(14)).join("");
  console.log("           " + slHeaders);
  for (const tp of tpValues) {
    const tpLabel = `TP${tpFmt(tp)}%`.padEnd(10);
    const cells = slValues.map(sl => {
      const expName = `Trump-top10-TP${tpFmt(tp)}-SL${slFmt(sl)}-h4-s1h`;
      const s = trumpTpSlResults.find(r => r.name === expName);
      return s ? `$${s.perDay.toFixed(2)}/d WR${s.winRate.toFixed(0)}%`.padStart(14) : "           N/A";
    }).join("");
    console.log(tpLabel + cells);
  }

  console.log("\n\n=== TRUMP STALE EXIT COMPARISON === (top10, TP5% SL2% hold4h)");
  printHeader();
  for (const s of trumpStaleResults) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== TRUMP MAX HOLD COMPARISON === (top10, TP5% SL2% stale1h@0.5%)");
  printHeader();
  for (const s of trumpHoldResults) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== TRUMP COMBINED vs SEPARATE ===");
  printHeader();
  for (const s of [garchBaseline, garchDefense, trumpCombinedNoDefense, trumpCombinedWithDefense]) {
    console.log(fmtRow(s));
  }

  // Trump top 5 risk-adjusted
  const trumpScored = sortedTrump.map(s => ({
    ...s,
    riskScore: s.maxDd > 0 ? (s.perDay * s.profitFactor) / s.maxDd : 0,
  }));
  trumpScored.sort((a, b) => b.riskScore - a.riskScore);

  console.log("\n\n=== TRUMP TOP 5 === (by $/day * PF / MaxDD)");
  printHeader();
  for (const s of trumpScored.slice(0, 5)) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== TRUMP PER-PAIR PROFITABILITY === (all20, TP5% SL2% hold4h stale1h@0.5%)");
  console.log(`${"Pair".padEnd(12)} | ${"Trades".padStart(6)} | ${"WR%".padStart(5)} | ${"PnL".padStart(7)} | ${"$/day".padStart(7)} | ${"MaxDD".padStart(6)} | ${"PF".padStart(5)} | ${"AvgW".padStart(7)} | ${"AvgL".padStart(8)}`);
  console.log("-".repeat(90));
  for (const s of trumpPerPairStats) {
    const wr = `${s.winRate.toFixed(0)}%`;
    const pnl = `$${s.totalPnl.toFixed(0)}`;
    const pd2 = `$${s.perDay.toFixed(2)}`;
    const dd = `$${s.maxDd.toFixed(0)}`;
    const pf = s.profitFactor.toFixed(2);
    const aw = `$${s.avgWin.toFixed(2)}`;
    const al = `$${s.avgLoss.toFixed(2)}`;
    console.log(`${s.name.padEnd(12)} | ${s.trades.toString().padStart(6)} | ${wr.padStart(5)} | ${pnl.padStart(7)} | ${pd2.padStart(7)} | ${dd.padStart(6)} | ${pf.padStart(5)} | ${aw.padStart(7)} | ${al.padStart(8)}`);
  }

  // ==============================
  // OUTPUT: All-events sections (new)
  // ==============================
  console.log("\n\n=== PHASE B: ALL BTC-MOVE EVENTS RESULTS ===\n");

  console.log("=== ALL-EVENTS TP/SL GRID === (top10 pairs, hold4h, stale1h@0.5%)");
  const aeTpVals = [0.03, 0.05, 0.07, 0.10];
  const aeSlVals = [0.01, 0.02, 0.03];
  const aeSlHeaders = aeSlVals.map(sl => `SL${(sl * 100).toFixed(0)}%`.padStart(18)).join("");
  console.log("           " + aeSlHeaders);
  for (const tp of aeTpVals) {
    const tpLabel2 = `TP${(tp * 100).toFixed(0)}%`.padEnd(10);
    const cells2 = aeSlVals.map(sl => {
      const expName = `AllEvt-top10-TP${(tp * 100).toFixed(0)}-SL${(sl * 100).toFixed(0)}-h4-s1h`;
      const s = allEvtTpSlResults.find(r => r.name === expName);
      return s ? `$${s.perDay.toFixed(2)}/d WR${s.winRate.toFixed(0)}% ${s.trades}t`.padStart(18) : "               N/A";
    }).join("");
    console.log(tpLabel2 + cells2);
  }

  console.log(`\nBest AllEvt TP/SL: ${bestAllEvtTpSl.name} -> $${bestAllEvtTpSl.perDay.toFixed(2)}/day WR${bestAllEvtTpSl.winRate.toFixed(0)}% ${bestAllEvtTpSl.trades} trades MaxDD $${bestAllEvtTpSl.maxDd.toFixed(0)}`);

  console.log("\n\n=== ALL-EVENTS STALE COMPARISON === (best TP/SL)");
  printHeader();
  for (const s of allEvtStaleResults) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== ALL-EVENTS PAIR SET COMPARISON === (best TP/SL)");
  printHeader();
  for (const s of allEvtPairSetResults) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== ALL-EVENTS FULL RESULTS === (sorted by $/day desc)");
  printHeader();
  const sortedAllEvt = [...allEvtResults].sort((a, b) => b.perDay - a.perDay);
  for (const s of sortedAllEvt) {
    console.log(fmtRow(s));
  }

  // ==============================
  // OUTPUT: Phase C - Combined
  // ==============================
  console.log("\n\n=== PHASE C: GARCH + ALL-EVENTS COMBINED ===");
  printHeader();
  for (const s of [garchBaseline, allEvtCombinedNoDefense, allEvtCombinedWithDefense]) {
    console.log(fmtRow(s));
  }

  // ==============================
  // PHASE D: Head-to-head comparison
  // ==============================
  console.log("\n\n=== PHASE D: TRUMP-ONLY vs ALL-EVENTS HEAD-TO-HEAD ===");
  const h2hHeader = `${"".padEnd(36)} | ${"Events".padStart(6)} | ${"Trades".padStart(6)} | ${"$/day".padStart(7)} | ${"WR%".padStart(5)} | ${"MaxDD".padStart(6)} | ${"Sharpe".padStart(6)} | ${"PF".padStart(5)}`;
  console.log(h2hHeader);
  console.log("-".repeat(100));

  function h2hRow(name: string, events: number, s: Stats): string {
    return `${pad(name, 36)} | ${pad(events, 6, true)} | ${pad(s.trades, 6, true)} | ${pad(`$${s.perDay.toFixed(2)}`, 7, true)} | ${pad(`${s.winRate.toFixed(0)}%`, 5, true)} | ${pad(`$${s.maxDd.toFixed(0)}`, 6, true)} | ${pad(s.sharpe.toFixed(2), 6, true)} | ${pad(s.profitFactor.toFixed(2), 5, true)}`;
  }

  console.log(h2hRow("Trump TP10/SL3 h8 s1h@0.3%", trumpEvents.length, trumpTP10SL3));
  console.log(h2hRow("AllEvt TP10/SL3 h8 s1h@0.3%", allBtcEvents.length, allEvtTP10SL3));
  console.log(h2hRow("Trump TP5/SL2 h4 s1h@0.5%", trumpEvents.length, trumpTP5SL2));
  console.log(h2hRow("AllEvt TP5/SL2 h4 s1h@0.5%", allBtcEvents.length, allEvtTP5SL2));
  console.log("-".repeat(100));
  console.log(h2hRow("GARCH baseline", 0, garchBaseline));
  console.log(h2hRow("GARCH + Trump combined", trumpEvents.length, trumpCombinedWithDefense));
  console.log(h2hRow("GARCH + AllEvt combined", allBtcEvents.length, allEvtCombinedWithDefense));

  // Best overall from all-events
  const bestAllEvt = [...allEvtResults].sort((a, b) => b.perDay - a.perDay)[0];
  const bestTrumpNews = [...allTrumpResults].filter(s => !s.name.includes("GARCH")).sort((a, b) => b.perDay - a.perDay)[0];

  // ==============================
  // FINAL RECOMMENDATION
  // ==============================
  console.log("\n\n=== FINAL RECOMMENDATION ===");
  console.log(`Trump-only events:       ${trumpEvents.length} events`);
  console.log(`All BTC-move events:     ${allBtcEvents.length} events (${(allBtcEvents.length / trumpEvents.length).toFixed(1)}x more)`);
  console.log(`Overlap:                 ${overlapCount} (${trumpEvents.length > 0 ? ((overlapCount / trumpEvents.length) * 100).toFixed(0) : 0}% of Trump events are also detected as BTC moves)`);
  console.log("");
  if (bestTrumpNews) {
    console.log(`Best Trump-only:         ${bestTrumpNews.name}`);
    console.log(`  -> $${bestTrumpNews.perDay.toFixed(2)}/day | WR ${bestTrumpNews.winRate.toFixed(0)}% | MaxDD $${bestTrumpNews.maxDd.toFixed(0)} | PF ${bestTrumpNews.profitFactor.toFixed(2)} | Sharpe ${bestTrumpNews.sharpe.toFixed(2)}`);
  }
  if (bestAllEvt) {
    console.log(`Best All-events:         ${bestAllEvt.name}`);
    console.log(`  -> $${bestAllEvt.perDay.toFixed(2)}/day | WR ${bestAllEvt.winRate.toFixed(0)}% | MaxDD $${bestAllEvt.maxDd.toFixed(0)} | PF ${bestAllEvt.profitFactor.toFixed(2)} | Sharpe ${bestAllEvt.sharpe.toFixed(2)}`);
  }
  console.log(`GARCH baseline:          $${garchBaseline.perDay.toFixed(2)}/day`);
  console.log(`GARCH + Trump combined:  $${trumpCombinedWithDefense.perDay.toFixed(2)}/day`);
  console.log(`GARCH + AllEvt combined: $${allEvtCombinedWithDefense.perDay.toFixed(2)}/day`);
  console.log("");

  const allEvtWinsTrump = bestAllEvt && bestTrumpNews && bestAllEvt.perDay > bestTrumpNews.perDay;
  const combinedAllEvtWins = allEvtCombinedWithDefense.perDay > trumpCombinedWithDefense.perDay;

  if (allEvtWinsTrump && combinedAllEvtWins) {
    console.log("VERDICT: All BTC-move events OUTPERFORM Trump-only on $/day. Higher frequency detection yields better results.");
    console.log(`  All-events: $${bestAllEvt!.perDay.toFixed(2)}/day vs Trump: $${bestTrumpNews!.perDay.toFixed(2)}/day (+$${(bestAllEvt!.perDay - bestTrumpNews!.perDay).toFixed(2)}/day)`);
  } else if (allEvtWinsTrump) {
    console.log("VERDICT: All BTC-move events outperform Trump-only standalone, but combined with GARCH, Trump events are better.");
  } else {
    console.log("VERDICT: Trump-only events outperform or match all BTC-move events. Trump signal has higher quality per-event.");
    if (bestTrumpNews && bestAllEvt) {
      console.log(`  Trump: $${bestTrumpNews.perDay.toFixed(2)}/day vs All-events: $${bestAllEvt.perDay.toFixed(2)}/day`);
    }
  }

  // Risk-adjusted verdict
  if (bestAllEvt && bestTrumpNews) {
    const trumpRiskAdj = bestTrumpNews.maxDd > 0 ? bestTrumpNews.perDay / bestTrumpNews.maxDd : 0;
    const allEvtRiskAdj = bestAllEvt.maxDd > 0 ? bestAllEvt.perDay / bestAllEvt.maxDd : 0;
    console.log(`\nRisk-adjusted ($/day per $MaxDD):`);
    console.log(`  Trump: ${trumpRiskAdj.toFixed(4)} | All-events: ${allEvtRiskAdj.toFixed(4)}`);
    if (allEvtRiskAdj > trumpRiskAdj) {
      console.log("  -> All-events is also better risk-adjusted");
    } else {
      console.log("  -> Trump-only is better risk-adjusted despite fewer events");
    }
  }
  console.log("");

  // Save output to file
  fs.writeFileSync("/tmp/335-all-events-backtest.txt", outputLines.join("\n"));
  origLog("[Output] Saved full results to /tmp/335-all-events-backtest.txt");
}

main().catch(console.error);
