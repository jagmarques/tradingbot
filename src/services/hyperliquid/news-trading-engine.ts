// News-driven trading engine: opens positions in the direction of AI-classified news events
// Uses trump-guard's news classification as signal, BTC EMA trend as filter
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { saveQuantPosition } from "../database/quant.js";
import { getClient, ensureConnected } from "./client.js";
import { loadEnv } from "../../config/env.js";
import { isQuantKilled } from "./risk-manager.js";
import { isInStopLossCooldown } from "./scheduler.js";
import { getLastNewsEvent } from "../trump-guard/monitor.js";

const TRADE_TYPE = "news-trade" as const;
const LEVERAGE = 10;
// Position sizing: equity split across active pairs
const MIN_POSITION_USD = 10;
const MAX_POSITION_USD = 500; // liquidity cap
const MAX_PAIRS = 20;

// SL/TP/trail config (HIGH only)
const IMPACT_CONFIG = {
  high:   { sl: 0.02, tp: 0, trailAct: 0.05, trailDist: 0.02 },   // 5%/2% trail
};

// Ordered by historical profitability + WR (best first, worst last)
const NEWS_TRADING_PAIRS = [
  "DOT", "TIA", "LDO", "kBONK", "WLD", "ARB", "ONDO", "ADA", "LINK", "DOGE",
  "XRP", "NEAR", "kSHIB", "SOL", "HYPE", "APT", "OP", "TRUMP", "ENA", "BNB",
];

// Track last processed event timestamp to avoid re-trading same event
// Seeded from DB on first call to survive restarts
let lastProcessedEventTs = 0;
let lastTradeOpenedTs = 0;
let seededFromDb = false;
const MIN_EVENT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between trades

function seedFromDb(): void {
  if (seededFromDb) return;
  seededFromDb = true;
  try {
    const positions = getOpenQuantPositions();
    const newsPositions = positions.filter(p => p.tradeType === "news-trade");
    if (newsPositions.length > 0) {
      // Extract event timestamp from indicators
      const etsMatch = newsPositions[0].indicatorsAtEntry?.match(/ets:(\d+)/);
      if (etsMatch) {
        lastProcessedEventTs = parseInt(etsMatch[1], 10);
        lastTradeOpenedTs = Date.now(); // assume recently opened
        console.log(`[News-Trade] Seeded from DB: lastEventTs=${lastProcessedEventTs}, ${newsPositions.length} open positions`);
      }
    }
  } catch { /* ignore on startup */ }
}

export async function runNewsTradingCycle(): Promise<number> {
  if (isQuantKilled()) return 0;
  seedFromDb();

  // Check for new news event
  const event = getLastNewsEvent();
  if (!event) return 0;
  if (event.ts <= lastProcessedEventTs) return 0; // already processed

  // Mark as processed immediately to avoid double-trading
  lastProcessedEventTs = event.ts;

  const impact = event.impact ?? "high";
  const cfg = IMPACT_CONFIG.high;
  console.log(`[News-Trade] New event: ${event.direction} [${impact}] - ${event.content.slice(0, 60)}`);

  // Only trade HIGH impact BREAKING news (MEDIUM loses money historically)
  if (impact !== "high") {
    console.log(`[News-Trade] Skipping ${impact} impact (only HIGH trades)`);
    return 0;
  }
  if (!event.isBreaking) {
    console.log(`[News-Trade] Skipping opinion piece (${impact} impact)`);
    return 0;
  }

  // Get BTC price for indicators
  const btcCandles = await fetchCandles("BTC", "1h", 30);
  if (btcCandles.length === 0) {
    console.log("[News-Trade] No BTC candles, skipping");
    return 0;
  }
  const btcPrice = btcCandles[btcCandles.length - 1].close;

  const direction = event.direction;

  // Get open positions for this trade type
  const openPositions = getOpenQuantPositions();
  const myPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);
  const openPairs = new Set(myPositions.map(p => p.pair));

  // If we have open positions, DON'T reverse - let them play out
  // Reversals are the #1 money killer (close 9 at loss + open 9 new = double slippage)
  if (myPositions.length > 0) {
    const existingDir = myPositions[0].direction;
    if (existingDir === direction) {
      console.log(`[News-Trade] Already positioned ${direction}, skipping`);
      return 0;
    }
    // Opposing direction: don't reverse, just skip
    console.log(`[News-Trade] Existing ${existingDir} positions open, skipping ${direction} event (no reversals)`);
    return 0;
  }

  // Cooldown: don't open new trades within 10 min of last trade
  if (Date.now() - lastTradeOpenedTs < MIN_EVENT_COOLDOWN_MS) {
    console.log(`[News-Trade] Cooldown: ${Math.round((MIN_EVENT_COOLDOWN_MS - (Date.now() - lastTradeOpenedTs)) / 60000)}min remaining, skipping`);
    return 0;
  }

  // Fetch live equity for compound sizing
  let equity = 200; // fallback
  try {
    await ensureConnected();
    const sdk = getClient();
    const env = loadEnv();
    const addr = env.HYPERLIQUID_WALLET_ADDRESS ?? "";
    const spotState = await sdk.info.spot.getSpotClearinghouseState(addr);
    const usdcBal = spotState.balances.find((b: { coin: string; total: string }) => b.coin === "USDC" || b.coin === "USDC-SPOT");
    if (usdcBal) equity = parseFloat(usdcBal.total);
  } catch { /* use fallback */ }

  // 80% of equity split across up to 20 pairs
  const affordablePairs = Math.max(1, Math.floor(equity * 0.80 / MIN_POSITION_USD));
  const maxPairs = Math.min(affordablePairs, MAX_PAIRS);
  const activePairs = NEWS_TRADING_PAIRS.slice(0, maxPairs);
  const compoundSize = Math.min(MAX_POSITION_USD, Math.max(MIN_POSITION_USD, Math.floor(equity * 0.80 / activePairs.length)));

  console.log(`[News-Trade] Size: $${compoundSize} x ${activePairs.length} pairs (equity=$${equity.toFixed(0)}, ${impact})`);

  let executed = 0;

  for (const pair of activePairs) {
    if (openPairs.has(pair)) continue;
    if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;

    try {
      if (executed > 0) await new Promise(r => setTimeout(r, 200));

      const altCandles = await fetchCandles(pair, "1h", 1);
      if (altCandles.length === 0) continue;
      const entryPrice = altCandles[altCandles.length - 1].close;

      const sl = direction === "long"
        ? entryPrice * (1 - cfg.sl)
        : entryPrice * (1 + cfg.sl);
      const tp = cfg.tp > 0
        ? (direction === "long" ? entryPrice * (1 + cfg.tp) : entryPrice * (1 - cfg.tp))
        : 0;

      console.log(`[News-Trade] Opening ${pair} ${direction} size=$${compoundSize} entry=${entryPrice} impact=${impact}`);

      const indicators = `impact:${impact}|src:${event.source ?? "unknown"}|btc:${btcPrice}|eq:${equity.toFixed(0)}|ets:${event.ts}|${event.content.slice(0, 100)}`;
      const position = await openPosition(
        pair, direction, compoundSize, LEVERAGE,
        sl, tp, "trending", TRADE_TYPE, indicators, entryPrice,
      );
      if (position) {
        position.btcPriceAtEntry = btcPrice;
        position.equityAtEntry = equity;
        saveQuantPosition(position);
        executed++;
        openPairs.add(pair);
      }
    } catch (err) {
      console.error(`[News-Trade] Error ${pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (executed > 0) lastTradeOpenedTs = Date.now();
  console.log(`[News-Trade] Opened ${executed} positions on ${direction} event (impact=${impact})`);
  return executed;
}
