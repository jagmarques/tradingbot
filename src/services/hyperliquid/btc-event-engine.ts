// BTC event-driven momentum engine: detects 0.7% BTC 1h moves, opens alts
// Optimized params from task 338 deep backtest (292 days, 3720 trades):
//   TP7/SL7: WR 53%, $14.96/day, PF 2.00, Sharpe 7.11, MaxDD $163
import { fetchCandles } from "./candles.js";
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { getClient, ensureConnected } from "./client.js";
import { loadEnv } from "../../config/env.js";
import { getDailyLossTotal } from "./risk-manager.js";
import { isInStopLossCooldown } from "./scheduler.js";
import { isTrumpCooldownActive } from "../trump-guard/index.js";

const TRADE_TYPE = "btc-event" as const;
const LEVERAGE = 10;
const RISK_PCT = 4; // compound 4% of equity per trade
const MIN_POSITION_USD = 10;
const EVENT_THRESHOLD = 0.007; // 0.7% BTC move
const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1h
const DAILY_CAP_PER_DIR = 10;
const SL_PCT = 0.07; // 7% (was 5%, optimized task 338)
const TP_PCT = 0.07; // 7% (was 5%, optimized task 338)
const DAILY_LOSS_LIMIT = 15; // $15
const MAX_PER_DIRECTION = 6; // (was 10, optimized task 338 for risk-adjusted)

// Proven top10 reactive pairs from research
const EVENT_TRADING_PAIRS = ["TIA", "kBONK", "OP", "LDO", "APT", "NEAR", "ARB", "ENA", "WLD", "ADA"];

// In-memory state
const lastEventTs = new Map<string, number>(); // "long"|"short" -> timestamp
const dailyEventCount = new Map<string, number>(); // "YYYY-MM-DD:long" -> count

function getDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyCountIfNeeded(): void {
  const today = getDayKey();
  for (const key of dailyEventCount.keys()) {
    if (!key.startsWith(today)) dailyEventCount.delete(key);
  }
}

export async function runBtcEventCycle(): Promise<number> {
  // Daily loss limit check
  const dailyLoss = getDailyLossTotal("btc-event", "live");
  if (dailyLoss >= DAILY_LOSS_LIMIT) {
    console.log(`[BTC-Event] Daily loss limit hit ($${dailyLoss.toFixed(2)} >= $${DAILY_LOSS_LIMIT}), skipping`);
    return 0;
  }

  // Fetch last 3 BTC 1h candles
  const btcCandles = await fetchCandles("BTC", "1h", 3);
  if (btcCandles.length < 2) {
    console.log("[BTC-Event] Insufficient BTC candles, skipping");
    return 0;
  }

  // Check the LAST CLOSED candle (length-2 since length-1 is forming)
  const lastClosed = btcCandles[btcCandles.length - 2];
  const move = Math.abs(lastClosed.close / lastClosed.open - 1);

  if (move < EVENT_THRESHOLD) return 0; // no event

  const direction: "long" | "short" = lastClosed.close > lastClosed.open ? "long" : "short";

  // Dedup check: skip if same direction event within dedup window
  const lastTs = lastEventTs.get(direction);
  if (lastTs && Date.now() - lastTs < DEDUP_WINDOW_MS) {
    console.log(`[BTC-Event] Dedup: ${direction} event within 1h window, skipping`);
    return 0;
  }

  // Daily cap check
  resetDailyCountIfNeeded();
  const dayKey = `${getDayKey()}:${direction}`;
  const dayCount = dailyEventCount.get(dayKey) ?? 0;
  if (dayCount >= DAILY_CAP_PER_DIR) {
    console.log(`[BTC-Event] Daily cap (${DAILY_CAP_PER_DIR}/${direction}) reached, skipping`);
    return 0;
  }

  // Record event
  lastEventTs.set(direction, Date.now());
  dailyEventCount.set(dayKey, dayCount + 1);

  console.log(`[BTC-Event] Detected ${(move * 100).toFixed(2)}% BTC move -> ${direction} event`);

  // Get open positions for this trade type
  const openPositions = getOpenQuantPositions();
  const myPositions = openPositions.filter(p => p.tradeType === TRADE_TYPE);
  const openPairs = new Set(myPositions.map(p => p.pair));

  // Compound sizing (same formula as garch-chan)
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
  // Risk 4% equity per trade: size = equity * riskPct / (SL * leverage)
  const compoundSize = Math.max(MIN_POSITION_USD, Math.floor(equity * (RISK_PCT / 100) / (SL_PCT * LEVERAGE)));

  let executed = 0;

  for (const pair of EVENT_TRADING_PAIRS) {
    if (openPairs.has(pair)) continue;
    if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;
    if (isTrumpCooldownActive(direction)) continue;

    const dirCount = myPositions.filter(p => p.direction === direction).length + executed;
    if (dirCount >= MAX_PER_DIRECTION) break;

    try {
      // Fetch latest price for the alt
      const altCandles = await fetchCandles(pair, "1h", 1);
      if (altCandles.length === 0) continue;
      const entryPrice = altCandles[altCandles.length - 1].close;

      const sl = direction === "long"
        ? entryPrice * (1 - SL_PCT)
        : entryPrice * (1 + SL_PCT);
      const tp = direction === "long"
        ? entryPrice * (1 + TP_PCT)
        : entryPrice * (1 - TP_PCT);

      console.log(`[BTC-Event] Opening ${pair} ${direction} size=$${compoundSize} (equity=$${equity.toFixed(0)})`);

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
      console.error(`[BTC-Event] Error ${pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[BTC-Event] Opened ${executed} positions on ${direction} event`);
  return executed;
}
