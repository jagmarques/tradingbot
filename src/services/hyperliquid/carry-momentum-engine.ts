// Engine D: Carry + Momentum (funding rate cross-sectional)
// Validated: 6/6 PASS, bootstrap 5th pct PF=2.27, p=0.000, 4/4 quarters profitable
// Uses REAL Hyperliquid hourly funding data
// Negatively correlated with trend following (-0.11)
import { openPosition, closePosition, getOpenQuantPositions } from "./executor.js";
import { QUANT_TRADING_PAIRS, ENSEMBLE_POSITION_SIZE_USD, ENSEMBLE_LEVERAGE, ENSEMBLE_MAX_CONCURRENT, ENSEMBLE_TRADE_TYPES } from "../../config/constants.js";
import { capStopLoss } from "./quant-utils.js";
import { isInStopLossCooldown } from "./scheduler.js";
import { getRegimeBias } from "../market-regime/fear-greed.js";
import { getEventSizeMultiplier } from "../market-regime/event-calendar.js";
import { getRegimeSizeMultiplier } from "../market-regime/fear-greed.js";

const TRADE_TYPE = "carry-momentum" as const;
const LOOKBACK_DAYS = 5;
const TOP_N = 3;
const SL_PCT = 0.04;
const REBALANCE_MS = 7 * 24 * 60 * 60 * 1000;

let lastRebalanceTs = 0;

async function fetchFundingHistory(pair: string, startTime: number): Promise<Array<{ fundingRate: number; time: number }>> {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fundingHistory", coin: pair, startTime }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((r: any) => ({
      fundingRate: parseFloat(r.fundingRate),
      time: r.time,
    }));
  } catch (err) {
    console.error(`[CarryMomentum] Failed to fetch funding for ${pair}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function fetchAllMids(): Promise<Record<string, number>> {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return {};
    const raw = await res.json() as Record<string, string>;
    const mids: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = parseFloat(v);
      if (!isNaN(n)) mids[k] = n;
    }
    return mids;
  } catch {
    return {};
  }
}

export async function runCarryMomentumCycle(): Promise<void> {
  const now = Date.now();

  // On restart (lastRebalanceTs=0), check if carry positions already exist
  // If they do, skip rebalance to avoid churning positions opened before restart
  if (lastRebalanceTs === 0) {
    const existing = getOpenQuantPositions().filter(p => p.tradeType === TRADE_TYPE);
    if (existing.length > 0) {
      const newestOpen = Math.max(...existing.map(p => new Date(p.openedAt).getTime()));
      lastRebalanceTs = newestOpen; // Set timer to last position open time
      console.log(`[CarryMomentum] Restart: found ${existing.length} existing positions, skip rebalance`);
      return;
    }
  }

  // Only rebalance weekly
  if (now - lastRebalanceTs < REBALANCE_MS) return;

  const lookbackMs = LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const startTime = now - lookbackMs;

  // Fetch all prices once (not per-pair)
  const allMids = await fetchAllMids();

  // Fetch funding rates and compute averages
  const pairData: Array<{ pair: string; avgFunding: number; momentum: number; price: number }> = [];

  for (const pair of QUANT_TRADING_PAIRS) {
    try {
      const funding = await fetchFundingHistory(pair, startTime);
      if (funding.length < 24) continue; // need at least 1 day of funding

      const avgFunding = funding.reduce((s, f) => s + f.fundingRate, 0) / funding.length;

      // Current price from cached allMids
      const price = allMids[pair];
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
    p => ENSEMBLE_TRADE_TYPES.has(p.tradeType ?? ""),
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
  const regimeBias = await getRegimeBias();

  for (const c of shortCandidates) {
    if (opened >= maxNew) break;
    if (regimeBias === "long") {
      console.log(`[CarryMomentum] ${c.pair} short blocked by Greed regime`);
      continue;
    }
    if (isInStopLossCooldown(c.pair, "short", TRADE_TYPE)) continue;
    const rawStop = c.price * (1 + SL_PCT);
    const stopLoss = capStopLoss(c.price, rawStop, "short");
    console.log(`[CarryMomentum] ${c.pair} funding=${(c.avgFunding * 100).toFixed(4)}%/h mom=${(c.momentum * 100).toFixed(1)}% -> SHORT`);
    const pos = await openPosition(
      c.pair, "short", ENSEMBLE_POSITION_SIZE_USD * getEventSizeMultiplier() * getRegimeSizeMultiplier(), ENSEMBLE_LEVERAGE,
      stopLoss, 0, "trending", TRADE_TYPE, `fund:${c.avgFunding.toFixed(8)}|mom:${c.momentum.toFixed(4)}`, c.price,
    );
    if (pos) opened++;
  }

  for (const c of longCandidates) {
    if (opened >= maxNew) break;
    if (regimeBias === "short") {
      console.log(`[CarryMomentum] ${c.pair} long blocked by Fear regime`);
      continue;
    }
    if (isInStopLossCooldown(c.pair, "long", TRADE_TYPE)) continue;
    const rawStop = c.price * (1 - SL_PCT);
    const stopLoss = capStopLoss(c.price, rawStop, "long");
    console.log(`[CarryMomentum] ${c.pair} funding=${(c.avgFunding * 100).toFixed(4)}%/h mom=${(c.momentum * 100).toFixed(1)}% -> LONG`);
    const pos = await openPosition(
      c.pair, "long", ENSEMBLE_POSITION_SIZE_USD * getEventSizeMultiplier() * getRegimeSizeMultiplier(), ENSEMBLE_LEVERAGE,
      stopLoss, 0, "trending", TRADE_TYPE, `fund:${c.avgFunding.toFixed(8)}|mom:${c.momentum.toFixed(4)}`, c.price,
    );
    if (pos) opened++;
  }

  console.log(`[CarryMomentum] Rebalance complete: ${opened} new positions, ${shortCandidates.length} short candidates, ${longCandidates.length} long candidates`);
}
