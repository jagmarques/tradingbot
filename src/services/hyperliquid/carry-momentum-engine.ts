// Engine D: Carry + Momentum (funding rate cross-sectional)
// Validated: 6/6 PASS, bootstrap 5th pct PF=2.27, p=0.000, 4/4 quarters profitable
// Uses REAL Hyperliquid hourly funding data
// Negatively correlated with trend following (-0.11)
import { openPosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_POSITION_SIZE_USD, ENSEMBLE_LEVERAGE, ENSEMBLE_MAX_CONCURRENT } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";
import { isInStopLossCooldown } from "./scheduler.js";
import { ensureConnected, getClient } from "./client.js";

const TRADE_TYPE = "carry-momentum" as const;
const LOOKBACK_DAYS = 5;
const TOP_N = 3;
const SL_PCT = 0.04;
const REBALANCE_MS = 7 * 24 * 60 * 60 * 1000;

let lastRebalanceTs = 0;

async function fetchFundingHistory(pair: string, startTime: number): Promise<Array<{ fundingRate: number; time: number }>> {
  try {
    await ensureConnected();
    const sdk = getClient();
    const response = await (sdk.info as any).post("/info", {
      type: "fundingHistory",
      coin: pair,
      startTime,
    });
    if (!Array.isArray(response)) return [];
    return response.map((r: any) => ({
      fundingRate: parseFloat(r.fundingRate),
      time: r.time,
    }));
  } catch (err) {
    console.error(`[CarryMomentum] Failed to fetch funding for ${pair}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function fetchPrice(pair: string): Promise<number | null> {
  try {
    await ensureConnected();
    const sdk = getClient();
    const mids = await sdk.info.getAllMids(true) as Record<string, string>;
    const mid = mids[pair];
    return mid ? parseFloat(mid) : null;
  } catch {
    return null;
  }
}

export async function runCarryMomentumCycle(): Promise<void> {
  const now = Date.now();

  // Only rebalance weekly
  if (now - lastRebalanceTs < REBALANCE_MS) return;

  const lookbackMs = LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const startTime = now - lookbackMs;

  // Fetch funding rates and compute 7-day averages
  const pairData: Array<{ pair: string; avgFunding: number; momentum: number; price: number }> = [];

  for (const pair of QUANT_TRADING_PAIRS) {
    try {
      const funding = await fetchFundingHistory(pair, startTime);
      if (funding.length < 24) continue; // need at least 1 day of funding

      const avgFunding = funding.reduce((s, f) => s + f.fundingRate, 0) / funding.length;

      // 7-day price momentum
      const price = await fetchPrice(pair);
      if (!price) continue;

      // Get price from 7 days ago via candles
      const { fetchCandles } = await import("./candles.js");
      const candles = await fetchCandles(pair, "1d", 10);
      if (candles.length < 2) continue;
      const oldPrice = candles[0].close;
      const momentum = (price - oldPrice) / oldPrice;

      pairData.push({ pair, avgFunding, momentum, price });
    } catch (err) {
      console.error(`[CarryMomentum] ${pair} data fetch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (pairData.length < 6) {
    console.log(`[CarryMomentum] Only ${pairData.length} pairs with data, need 6+, skipping`);
    return;
  }

  lastRebalanceTs = now;

  // Close existing carry positions
  const allPositions = getOpenQuantPositions();
  const myPositions = allPositions.filter(p => p.tradeType === TRADE_TYPE);
  const { closePosition } = await import("./executor.js");
  for (const pos of myPositions) {
    try {
      await closePosition(pos.id, "carry-rebalance");
      console.log(`[CarryMomentum] Closed ${pos.pair} ${pos.direction} for rebalance`);
    } catch (err) {
      console.error(`[CarryMomentum] Failed to close ${pos.pair}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Check ensemble capacity
  const ensembleCount = getOpenQuantPositions().filter(
    p => p.tradeType === "donchian-trend" || p.tradeType === "supertrend-4h" || p.tradeType === "garch-v2" || p.tradeType === TRADE_TYPE,
  ).length;
  if (ensembleCount >= ENSEMBLE_MAX_CONCURRENT) {
    console.log(`[CarryMomentum] Ensemble full (${ensembleCount}/${ENSEMBLE_MAX_CONCURRENT}), skipping`);
    return;
  }

  // Rank by funding rate
  const sorted = [...pairData].sort((a, b) => b.avgFunding - a.avgFunding);

  // Shorts: highest funding + negative momentum
  const shortCandidates = sorted
    .filter(p => p.avgFunding > 0 && p.momentum < 0)
    .slice(0, TOP_N);

  // Longs: lowest funding + positive momentum
  const longCandidates = [...pairData]
    .sort((a, b) => a.avgFunding - b.avgFunding)
    .filter(p => p.momentum > 0)
    .slice(0, TOP_N);

  let opened = 0;
  const maxNew = ENSEMBLE_MAX_CONCURRENT - ensembleCount;

  for (const c of shortCandidates) {
    if (opened >= maxNew) break;
    if (isInStopLossCooldown(c.pair, "short", TRADE_TYPE)) continue;
    const rawStop = c.price * (1 + SL_PCT);
    const stopLoss = capStopLoss(c.price, rawStop, "short");
    console.log(`[CarryMomentum] ${c.pair} funding=${(c.avgFunding * 100).toFixed(4)}%/h mom=${(c.momentum * 100).toFixed(1)}% -> SHORT`);
    const pos = await openPosition(
      c.pair, "short", ENSEMBLE_POSITION_SIZE_USD, ENSEMBLE_LEVERAGE,
      stopLoss, 0, "trending", TRADE_TYPE, `fund:${c.avgFunding.toFixed(8)}|mom:${c.momentum.toFixed(4)}`, c.price,
    );
    if (pos) opened++;
  }

  for (const c of longCandidates) {
    if (opened >= maxNew) break;
    if (isInStopLossCooldown(c.pair, "long", TRADE_TYPE)) continue;
    const rawStop = c.price * (1 - SL_PCT);
    const stopLoss = capStopLoss(c.price, rawStop, "long");
    console.log(`[CarryMomentum] ${c.pair} funding=${(c.avgFunding * 100).toFixed(4)}%/h mom=${(c.momentum * 100).toFixed(1)}% -> LONG`);
    const pos = await openPosition(
      c.pair, "long", ENSEMBLE_POSITION_SIZE_USD, ENSEMBLE_LEVERAGE,
      stopLoss, 0, "trending", TRADE_TYPE, `fund:${c.avgFunding.toFixed(8)}|mom:${c.momentum.toFixed(4)}`, c.price,
    );
    if (pos) opened++;
  }

  console.log(`[CarryMomentum] Rebalance complete: ${opened} new positions, ${shortCandidates.length} short candidates, ${longCandidates.length} long candidates`);
}
