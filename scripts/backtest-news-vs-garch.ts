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

const CRYPTO_KEYWORDS = [
  "crypto", "bitcoin", "btc", "ethereum", "tariff", "trade war", "reserve",
  "defi", "blockchain", "digital asset", "stablecoin", "sec", "cftc",
  "regulation", "ban", "executive order", "tax", "sanctions", "china",
  "russia", "iran", "powell", "fed", "rate", "interest rate", "inflation",
  "economy", "recession", "stimulus", "debt ceiling", "default", "shutdown",
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

    const THRESHOLD = 0.003; // 0.3%
    if (maxUp > THRESHOLD) {
      events.push({ ts: postTs, direction: "long" });
    } else if (maxDown < -THRESHOLD) {
      events.push({ ts: postTs, direction: "short" });
    }
  }

  // Sort by time
  events.sort((a, b) => a.ts - b.ts);
  console.log(`[News] Scanned ${posts.filter(p => {
    const ts = new Date(p.created_at).getTime();
    return ts >= START_TS && ts <= END_TS;
  }).length} posts in period, ${relevantCount} crypto-relevant, found ${events.length} price-confirmed events`);
  return events;
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

function computeStats(name: string, trades: Trade[], equityCurve: number[]): Stats {
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;

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

    // Check for news events in the last hour [ts - HOUR_MS, ts)
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

      // Stale exit (news positions only)
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

    equityCurve.push(cumulativePnl);
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
  console.log("=== Comprehensive News vs GARCH v2 Backtest ===");
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

  // Load news events
  const newsEvents = loadNewsEvents();
  console.log(`\nRunning simulations...\n`);

  // ---- Build Configs ----

  const allResults: Stats[] = [];

  // Helper to run a config
  function run(cfg: SimConfig): Stats {
    const { trades, equityCurve } = simulate(cfg, pairDataMap, btcPd, newsEvents);
    return computeStats(cfg.name, trades, equityCurve);
  }

  // 1. GARCH v2 baseline
  const garchBaseline = run({
    name: "GARCH-v2-baseline",
    runGarch: true, runNews: false,
    garchDefense: false, garchCooldown: false, sharedCap: false,
  });
  allResults.push(garchBaseline);

  // 2. GARCH + defense only
  const garchDefense = run({
    name: "GARCH+defense",
    runGarch: true, runNews: false,
    garchDefense: true, garchCooldown: true, sharedCap: false,
  });
  allResults.push(garchDefense);

  // ---- News-only configs ----

  // Section A: pair set sweep (fixed SL2% TP5% hold4h stale1h@0.5%)
  const pairSets = [
    { name: "all20", pairs: ALL20 },
    { name: "top15", pairs: TOP15 },
    { name: "top10", pairs: TOP10 },
    { name: "top5", pairs: TOP5 },
  ];
  const pairSetResults: Stats[] = [];
  for (const ps of pairSets) {
    const s = run({
      name: `News-${ps.name}-TP5-SL2-h4-s1h`,
      runGarch: false, runNews: true,
      newsConfig: { tp: 0.05, sl: 0.02, maxHoldMs: 4 * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.005, pairs: ps.pairs },
      garchDefense: false, garchCooldown: false, sharedCap: false,
    });
    pairSetResults.push(s);
    allResults.push(s);
  }

  // Section B: TP x SL grid (top10, stale1h@0.5%, hold4h)
  const tpValues = [0.03, 0.05, 0.07, 0.10];
  const slValues = [0.01, 0.015, 0.02, 0.03];
  const tpSlResults: Stats[] = [];
  for (const tp of tpValues) {
    for (const sl of slValues) {
      const slLabel = sl === 0.015 ? "1.5" : (sl * 100).toFixed(0);
      const s = run({
        name: `News-top10-TP${(tp * 100).toFixed(0)}-SL${slLabel}-h4-s1h`,
        runGarch: false, runNews: true,
        newsConfig: { tp, sl, maxHoldMs: 4 * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.005, pairs: TOP10 },
        garchDefense: false, garchCooldown: false, sharedCap: false,
      });
      tpSlResults.push(s);
      allResults.push(s);
    }
  }

  // Section C: stale exit sweep (top10, SL2% TP5% hold4h)
  const staleConfigs = [
    { name: "no-stale", staleCheckMs: 0, staleMinMove: 0 },
    { name: "s30m@0.3%", staleCheckMs: 30 * 60_000, staleMinMove: 0.003 },
    { name: "s1h@0.5%", staleCheckMs: HOUR_MS, staleMinMove: 0.005 },
    { name: "s1h@1%", staleCheckMs: HOUR_MS, staleMinMove: 0.01 },
    { name: "s2h@0.5%", staleCheckMs: 2 * HOUR_MS, staleMinMove: 0.005 },
  ];
  const staleResults: Stats[] = [];
  for (const sc of staleConfigs) {
    const s = run({
      name: `News-top10-TP5-SL2-h4-${sc.name}`,
      runGarch: false, runNews: true,
      newsConfig: { tp: 0.05, sl: 0.02, maxHoldMs: 4 * HOUR_MS, staleCheckMs: sc.staleCheckMs, staleMinMove: sc.staleMinMove, pairs: TOP10 },
      garchDefense: false, garchCooldown: false, sharedCap: false,
    });
    staleResults.push(s);
    allResults.push(s);
  }

  // Section D: max hold sweep (top10, SL2% TP5% stale1h@0.5%)
  const holdConfigs = [2, 4, 6, 8, 12];
  const holdResults: Stats[] = [];
  for (const h of holdConfigs) {
    const s = run({
      name: `News-top10-TP5-SL2-h${h}-s1h`,
      runGarch: false, runNews: true,
      newsConfig: { tp: 0.05, sl: 0.02, maxHoldMs: h * HOUR_MS, staleCheckMs: HOUR_MS, staleMinMove: 0.005, pairs: TOP10 },
      garchDefense: false, garchCooldown: false, sharedCap: false,
    });
    holdResults.push(s);
    allResults.push(s);
  }

  // Best news config (all20, TP5%, SL2%, hold4h, stale1h@0.5%)
  const bestNewsConfig: NewsConfig = {
    tp: 0.05, sl: 0.02, maxHoldMs: 4 * HOUR_MS,
    staleCheckMs: HOUR_MS, staleMinMove: 0.005,
    pairs: ALL20,
  };

  // 3. Combined configs
  const combinedShared = run({
    name: "Combined-shared-cap",
    runGarch: true, runNews: true,
    newsConfig: bestNewsConfig,
    garchDefense: true, garchCooldown: true, sharedCap: true,
  });
  allResults.push(combinedShared);

  const combinedSeparate = run({
    name: "Combined-separate-cap",
    runGarch: true, runNews: true,
    newsConfig: bestNewsConfig,
    garchDefense: true, garchCooldown: true, sharedCap: false,
  });
  allResults.push(combinedSeparate);

  const combinedNoDefense = run({
    name: "Combined-no-defense",
    runGarch: true, runNews: true,
    newsConfig: bestNewsConfig,
    garchDefense: false, garchCooldown: false, sharedCap: false,
  });
  allResults.push(combinedNoDefense);

  // ---- Per-pair news analysis (best news config = all20) ----
  const perPairStats: Stats[] = [];
  const { trades: bestNewsTrades } = simulate({
    name: "best-news-all20",
    runGarch: false, runNews: true,
    newsConfig: bestNewsConfig,
    garchDefense: false, garchCooldown: false, sharedCap: false,
  }, pairDataMap, btcPd, newsEvents);

  for (const shortPair of ALL20) {
    const pairTrades = bestNewsTrades.filter(t => t.pair === shortPair);
    if (pairTrades.length === 0) continue;
    let maxDd = 0, peak = -Infinity, cum = 0;
    for (const t of pairTrades) {
      cum += t.pnl;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
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
    perPairStats.push({
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
  perPairStats.sort((a, b) => b.perDay - a.perDay);

  // ---- OUTPUT ----

  console.log("\n=== STRATEGY COMPARISON === (sorted by $/day desc)");
  printHeader();
  const sortedAll = [...allResults].sort((a, b) => b.perDay - a.perDay);
  for (const s of sortedAll) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== NEWS PAIR SET COMPARISON ===");
  printHeader();
  for (const s of pairSetResults) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== NEWS TP/SL GRID === (top10 pairs, hold4h, stale1h@0.5%)");
  // Grid names use format: News-top10-TP{tp}-SL{sl}-h4-s1h
  const slFmt = (sl: number) => sl === 0.015 ? "1.5" : (sl * 100).toFixed(0);
  const tpFmt = (tp: number) => (tp * 100).toFixed(0);
  const slHeaders = slValues.map(sl => `SL${slFmt(sl)}%`.padStart(14)).join("");
  console.log("           " + slHeaders);
  for (const tp of tpValues) {
    const tpLabel = `TP${tpFmt(tp)}%`.padEnd(10);
    const cells = slValues.map(sl => {
      const expName = `News-top10-TP${tpFmt(tp)}-SL${slFmt(sl)}-h4-s1h`;
      const s = tpSlResults.find(r => r.name === expName);
      return s ? `$${s.perDay.toFixed(2)}/d WR${s.winRate.toFixed(0)}%`.padStart(14) : "           N/A";
    }).join("");
    console.log(tpLabel + cells);
  }

  console.log("\n\n=== NEWS STALE EXIT COMPARISON === (top10, TP5% SL2% hold4h)");
  printHeader();
  for (const s of staleResults) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== NEWS MAX HOLD COMPARISON === (top10, TP5% SL2% stale1h@0.5%)");
  printHeader();
  for (const s of holdResults) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== COMBINED vs SEPARATE ===");
  printHeader();
  for (const s of [garchBaseline, garchDefense, combinedShared, combinedSeparate, combinedNoDefense]) {
    console.log(fmtRow(s));
  }

  // Top 5 by risk-adjusted score
  const scored = sortedAll.map(s => ({
    ...s,
    riskScore: s.maxDd > 0 ? (s.perDay * s.profitFactor) / s.maxDd : 0,
  }));
  scored.sort((a, b) => b.riskScore - a.riskScore);

  console.log("\n\n=== TOP 5 OVERALL === (by $/day * PF / MaxDD)");
  printHeader();
  for (const s of scored.slice(0, 5)) {
    console.log(fmtRow(s));
  }

  console.log("\n\n=== PER-PAIR NEWS PROFITABILITY === (best news config: all20, TP5% SL2% hold4h stale1h@0.5%)");
  console.log(`${"Pair".padEnd(12)} | ${"Trades".padStart(6)} | ${"WR%".padStart(5)} | ${"PnL".padStart(7)} | ${"$/day".padStart(7)} | ${"MaxDD".padStart(6)} | ${"PF".padStart(5)} | ${"AvgW".padStart(7)} | ${"AvgL".padStart(8)}`);
  console.log("-".repeat(90));
  for (const s of perPairStats) {
    const wr = `${s.winRate.toFixed(0)}%`;
    const pnl = `$${s.totalPnl.toFixed(0)}`;
    const pd2 = `$${s.perDay.toFixed(2)}`;
    const dd = `$${s.maxDd.toFixed(0)}`;
    const pf = s.profitFactor.toFixed(2);
    const aw = `$${s.avgWin.toFixed(2)}`;
    const al = `$${s.avgLoss.toFixed(2)}`;
    console.log(`${s.name.padEnd(12)} | ${s.trades.toString().padStart(6)} | ${wr.padStart(5)} | ${pnl.padStart(7)} | ${pd2.padStart(7)} | ${dd.padStart(6)} | ${pf.padStart(5)} | ${aw.padStart(7)} | ${al.padStart(8)}`);
  }

  // Final recommendation
  const bestOverall = scored[0];
  const bestNews = pairSetResults.sort((a, b) => b.perDay - a.perDay)[0];
  const bestCombined = [combinedShared, combinedSeparate, combinedNoDefense].sort((a, b) => b.perDay - a.perDay)[0];

  console.log("\n\n=== FINAL RECOMMENDATION ===");
  console.log(`Best news config:     ${bestNews.name}`);
  console.log(`  -> $${bestNews.perDay.toFixed(2)}/day | WR ${bestNews.winRate.toFixed(0)}% | MaxDD $${bestNews.maxDd.toFixed(0)} | PF ${bestNews.profitFactor.toFixed(2)} | Sharpe ${bestNews.sharpe.toFixed(2)}`);
  console.log(`Best combined:        ${bestCombined.name}`);
  console.log(`  -> $${bestCombined.perDay.toFixed(2)}/day | WR ${bestCombined.winRate.toFixed(0)}% | MaxDD $${bestCombined.maxDd.toFixed(0)} | PF ${bestCombined.profitFactor.toFixed(2)} | Sharpe ${bestCombined.sharpe.toFixed(2)}`);
  console.log(`Best risk-adjusted:   ${bestOverall.name}`);
  console.log(`  -> $${bestOverall.perDay.toFixed(2)}/day | Score ${(bestOverall as Stats & { riskScore: number }).riskScore.toFixed(4)}`);
  console.log("");
  console.log(`GARCH v2 baseline:    $${garchBaseline.perDay.toFixed(2)}/day`);
  console.log(`GARCH + defense:      $${garchDefense.perDay.toFixed(2)}/day (delta: +$${(garchDefense.perDay - garchBaseline.perDay).toFixed(2)}/day)`);
  console.log(`News alone (best):    $${bestNews.perDay.toFixed(2)}/day`);
  console.log(`Combined (best):      $${bestCombined.perDay.toFixed(2)}/day`);

  const addingNewsHelps = bestCombined.perDay > garchDefense.perDay;
  const newsAloneWins = bestNews.perDay > bestCombined.perDay;
  console.log("");
  if (newsAloneWins) {
    console.log("VERDICT: News-only trading outperforms GARCH on $/day. Consider running news engine as primary strategy.");
  } else if (addingNewsHelps) {
    console.log(`VERDICT: Adding news offense to GARCH+defense adds +$${(bestCombined.perDay - garchDefense.perDay).toFixed(2)}/day. Recommend building news trading engine.`);
  } else {
    console.log("VERDICT: Adding news offense does not improve over GARCH+defense alone. Keep defense only.");
  }
  console.log("");
}

main().catch(console.error);
