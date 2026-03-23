// News-driven trading engine: opens positions in the direction of AI-classified news events
// Uses trump-guard's news classification as signal, BTC EMA trend as filter
import { EMA } from "technicalindicators";
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { getClient, ensureConnected } from "./client.js";
import { loadEnv } from "../../config/env.js";
import { getDailyLossTotal } from "./risk-manager.js";
import { isInStopLossCooldown } from "./scheduler.js";
import { getLastNewsEvent } from "../trump-guard/monitor.js";

const TRADE_TYPE = "news-trade" as const;
const LEVERAGE = 10;
const EVENT_RISK_PCT = 4; // 4% of equity per event (split across pairs)
const MIN_POSITION_USD = 10;
const MAX_POSITION_USD = 500; // liquidity cap
const SL_PCT = 0.02; // 2% price-based SL
const DAILY_LOSS_LIMIT = 15;

const NEWS_TRADING_PAIRS = [
  "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA", "DOGE", "APT", "LINK", "ADA",
  "WLD", "XRP", "SOL", "BNB", "kSHIB", "TIA", "NEAR", "kBONK", "ONDO", "HYPE",
];

// Track last processed event timestamp to avoid re-trading same event
let lastProcessedEventTs = 0;

export async function runNewsTradingCycle(): Promise<number> {
  // Daily loss limit check
  const dailyLoss = getDailyLossTotal("news-trade", "live");
  if (dailyLoss >= DAILY_LOSS_LIMIT) {
    console.log(`[News-Trade] Daily loss limit hit ($${dailyLoss.toFixed(2)} >= $${DAILY_LOSS_LIMIT}), skipping`);
    return 0;
  }

  // Check for new news event
  const event = getLastNewsEvent();
  if (!event) return 0;
  if (event.ts <= lastProcessedEventTs) return 0; // already processed

  // Mark as processed immediately to avoid double-trading
  lastProcessedEventTs = event.ts;

  console.log(`[News-Trade] New event: ${event.direction} - ${event.content.slice(0, 60)}`);

  // BTC EMA9/21 trend filter
  const btcCandles = await fetchCandles("BTC", "1h", 30);
  if (btcCandles.length < 21) {
    console.log("[News-Trade] Insufficient BTC candles for trend filter, skipping");
    return 0;
  }
  const btcCloses = btcCandles.map(c => c.close);
  const ema9Vals = EMA.calculate({ period: 9, values: btcCloses });
  const ema21Vals = EMA.calculate({ period: 21, values: btcCloses });
  if (ema9Vals.length === 0 || ema21Vals.length === 0) {
    console.log("[News-Trade] EMA calculation failed, skipping");
    return 0;
  }
  const ema9 = ema9Vals[ema9Vals.length - 1];
  const ema21 = ema21Vals[ema21Vals.length - 1];
  const btcUptrend = ema9 > ema21;

  // Only long in uptrend, short in downtrend
  if (event.direction === "long" && !btcUptrend) {
    console.log("[News-Trade] Trend filter: EMA9 < EMA21, skipping long");
    return 0;
  }
  if (event.direction === "short" && btcUptrend) {
    console.log("[News-Trade] Trend filter: EMA9 > EMA21, skipping short");
    return 0;
  }

  // Get open positions for this trade type
  const openPositions = getOpenQuantPositions();
  const myPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);
  const openPairs = new Set(myPositions.map(p => p.pair));

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

  // Compound size: equity * (EVENT_RISK_PCT / 100) / (numPairs * SL_PCT * LEVERAGE)
  const numPairs = NEWS_TRADING_PAIRS.length;
  const rawSize = equity * (EVENT_RISK_PCT / 100) / (numPairs * SL_PCT * LEVERAGE);
  const compoundSize = Math.min(MAX_POSITION_USD, Math.max(MIN_POSITION_USD, Math.floor(rawSize)));

  console.log(`[News-Trade] Compound size: $${compoundSize} (equity=$${equity.toFixed(0)}, risk=${EVENT_RISK_PCT}%, pairs=${numPairs})`);

  let executed = 0;
  const direction = event.direction;

  for (const pair of NEWS_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;

    try {
      // Fetch latest price
      const altCandles = await fetchCandles(pair, "1h", 1);
      if (altCandles.length === 0) continue;
      const entryPrice = altCandles[altCandles.length - 1].close;

      const sl = direction === "long"
        ? entryPrice * (1 - SL_PCT)
        : entryPrice * (1 + SL_PCT);

      // No take profit - trail-only via position monitor
      const tp = 0;

      console.log(`[News-Trade] Opening ${pair} ${direction} size=$${compoundSize} entry=${entryPrice}`);

      const position = await openPosition(
        pair, direction, compoundSize, LEVERAGE,
        sl, tp, "trending", TRADE_TYPE, undefined, entryPrice,
      );
      if (position) {
        executed++;
        openPairs.add(pair);
        myPositions.push(position);
      }
    } catch (err) {
      console.error(`[News-Trade] Error ${pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[News-Trade] Opened ${executed} positions on ${direction} event`);
  return executed;
}
