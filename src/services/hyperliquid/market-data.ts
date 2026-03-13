import { ensureConnected, getClient } from "./client.js";
import type { FundingInfo, OrderbookImbalance } from "./types.js";

const FUNDING_PERIODS_PER_YEAR = 24 * 365; // 1-hour funding periods (Hyperliquid)

export async function fetchFundingRate(pair: string): Promise<FundingInfo | null> {
  try {
    await ensureConnected();
    const sdk = getClient();

    const fundings = await sdk.info.perpetuals.getPredictedFundings(true);
    // SDK returns { [coin]: VenueFunding[] }
    const venueFundingList = fundings[pair];
    if (!venueFundingList || venueFundingList.length === 0) {
      return null;
    }

    const firstVenue = venueFundingList[0];
    const venueName = Object.keys(firstVenue)[0];
    const fundingData = venueName ? firstVenue[venueName] : undefined;

    const currentRate = fundingData ? parseFloat(String(fundingData.fundingRate ?? 0)) : 0;
    const annualizedRate = currentRate * FUNDING_PERIODS_PER_YEAR;
    const nextFundingTime = fundingData?.nextFundingTime
      ? Number(fundingData.nextFundingTime)
      : Date.now() + 8 * 60 * 60 * 1000;

    console.log(
      `[Hyperliquid] Funding rate for ${pair}: ${(currentRate * 100).toFixed(4)}% (${(annualizedRate * 100).toFixed(2)}% annualized)`,
    );

    return {
      pair,
      currentRate,
      annualizedRate,
      nextFundingTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hyperliquid] Failed to fetch funding rate for ${pair}: ${msg}`);
    return null;
  }
}

export async function fetchOpenInterest(pair: string): Promise<number> {
  try {
    await ensureConnected();
    const sdk = getClient();

    const [meta, assetCtxs] = await sdk.info.perpetuals.getMetaAndAssetCtxs(true);
    const idx = meta.universe.findIndex((u) => u.name === pair);
    if (idx === -1) {
      console.warn(`[Hyperliquid] Pair ${pair} not found in universe`);
      return 0;
    }

    const ctx = assetCtxs[idx];
    const oi = parseFloat(String(ctx.openInterest ?? 0));
    console.log(`[Hyperliquid] Open interest for ${pair}: ${oi.toFixed(2)}`);
    return oi;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hyperliquid] Failed to fetch open interest for ${pair}: ${msg}`);
    return 0;
  }
}

export async function fetchMarketContext(pair: string): Promise<{
  markPrice: number;
  oraclePrice: number;
  dayVolume: number;
  fundingRate: number;
  openInterest: number;
}> {
  try {
    await ensureConnected();
    const sdk = getClient();

    const [meta, assetCtxs] = await sdk.info.perpetuals.getMetaAndAssetCtxs(true);
    const idx = meta.universe.findIndex((u) => u.name === pair);
    if (idx === -1) {
      console.warn(`[Hyperliquid] Pair ${pair} not found in universe`);
      return { markPrice: 0, oraclePrice: 0, dayVolume: 0, fundingRate: 0, openInterest: 0 };
    }

    const ctx = assetCtxs[idx];
    const markPrice = parseFloat(String(ctx.markPx ?? 0));
    const oraclePrice = parseFloat(String(ctx.oraclePx ?? 0));
    const dayVolume = parseFloat(String(ctx.dayNtlVlm ?? 0));
    const fundingRate = parseFloat(String(ctx.funding ?? 0));
    const openInterest = parseFloat(String(ctx.openInterest ?? 0));

    console.log(
      `[Hyperliquid] Market context for ${pair}: mark=$${markPrice.toFixed(2)}, oi=${openInterest.toFixed(2)}, funding=${(fundingRate * 100).toFixed(4)}%`,
    );

    return { markPrice, oraclePrice, dayVolume, fundingRate, openInterest };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hyperliquid] Failed to fetch market context for ${pair}: ${msg}`);
    return { markPrice: 0, oraclePrice: 0, dayVolume: 0, fundingRate: 0, openInterest: 0 };
  }
}


export async function fetchOrderbookDepth(pair: string, markPrice: number): Promise<OrderbookImbalance | null> {
  try {
    await ensureConnected();
    const sdk = getClient();

    const l2Book = await sdk.info.getL2Book(pair, true);
    const bids = l2Book.levels[0] ?? [];
    const asks = l2Book.levels[1] ?? [];

    if (bids.length === 0 || asks.length === 0) {
      console.warn(`[Hyperliquid] Empty L2 book for ${pair}`);
      return null;
    }

    const mid = markPrice > 0 ? markPrice : parseFloat(bids[0].px);
    const bidThreshold = mid * 0.98;
    const askThreshold = mid * 1.02;

    let bidDepthUsd = 0;
    for (const level of bids) {
      const px = parseFloat(level.px);
      if (px >= bidThreshold) {
        bidDepthUsd += parseFloat(level.sz) * px;
      }
    }

    let askDepthUsd = 0;
    for (const level of asks) {
      const px = parseFloat(level.px);
      if (px <= askThreshold) {
        askDepthUsd += parseFloat(level.sz) * px;
      }
    }

    const totalDepth = bidDepthUsd + askDepthUsd;
    const imbalanceRatio = totalDepth > 0 ? bidDepthUsd / totalDepth : 0.5;

    const bestBid = parseFloat(bids[0].px);
    const bestAsk = parseFloat(asks[0].px);
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

    console.log(
      `[Hyperliquid] Orderbook ${pair}: bid=$${bidDepthUsd.toFixed(0)}, ask=$${askDepthUsd.toFixed(0)}, imbalance=${imbalanceRatio.toFixed(3)}`,
    );

    return { bidDepthUsd, askDepthUsd, imbalanceRatio, spreadBps };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Hyperliquid] Failed to fetch orderbook for ${pair}: ${msg}`);
    return null;
  }
}

const previousOI = new Map<string, number>();

export function computeOIDelta(
  pair: string,
  currentOI: number,
): { oiDelta: number; oiDeltaPct: number } | null {
  const prev = previousOI.get(pair);
  previousOI.set(pair, currentOI);

  if (prev === undefined) {
    return null;
  }

  const delta = currentOI - prev;
  const deltaPct = prev !== 0 ? (delta / prev) * 100 : 0;

  const sign = delta > 0 ? "+" : "";
  console.log(`[Hyperliquid] OI delta ${pair}: ${sign}${delta.toFixed(0)} (${deltaPct.toFixed(2)}%)`);

  return { oiDelta: delta, oiDeltaPct: deltaPct };
}
